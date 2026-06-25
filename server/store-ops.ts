/* ============================================================
   NULLPOINT // SERVER-SIDE STORE OPS
   CRUD used by the MCP server. Writes go through the SAME applyOps path the web
   client uses (full-row upsert, rev-guarded, seq-bumping, one transaction), so
   the web app's incremental pull picks up anything the agent changes. Mirrors
   the client's cascade semantics (deleting a project/task detaches its children
   rather than orphaning dangling links).
   ============================================================ */
import { sql, applyOps, getState, ROW_TO_CLIENT } from "./db.ts";

const now = () => new Date().toISOString();
const uid = (p: string) => p + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const op = (entity: string, id: string, rev: number, t: string, data: any, deletedAt: string | null = null) =>
  ({ opId: uid("op"), entity, id, rev, updatedAt: t, deletedAt, data: { ...data, rev, updatedAt: t, deletedAt } });

const normContexts = (a: any) => Array.isArray(a) ? [...new Set(a.map((c) => String(c).trim()).filter(Boolean).map((c) => (c.startsWith("@") ? c : "@" + c).toLowerCase()))] : [];
const normTags = (a: any) => Array.isArray(a) ? [...new Set(a.map((t) => String(t).replace(/^#/, "").trim().toLowerCase()).filter(Boolean))] : [];

/* read one current (non-deleted) row in client shape, or null */
async function read(entity: "tasks" | "projects" | "notes", id: string) {
  const rows = entity === "tasks" ? await sql`select * from tasks where id=${id} and deleted_at is null`
    : entity === "projects" ? await sql`select * from projects where id=${id} and deleted_at is null`
    : await sql`select * from notes where id=${id} and deleted_at is null`;
  return rows.length ? (ROW_TO_CLIENT as any)[entity](rows[0]) : null;
}

/* ---------------- TASKS ---------------- */
export async function createTask(f: any) {
  const t = now(), id = uid("tsk");
  const data = {
    id, title: f.title || "Untitled", status: f.status || "inbox", projectId: f.projectId ?? null,
    contexts: normContexts(f.contexts), due: f.due ?? null, waitingFor: f.waitingFor || "", flagged: !!f.flagged,
    createdAt: t, completedAt: f.status === "done" ? t : null,
  };
  await applyOps([op("tasks", id, 1, t, data)]);
  return read("tasks", id);
}
export async function updateTask(id: string, patch: any) {
  const cur = await read("tasks", id); if (!cur) return null;
  const t = now();
  const next: any = { ...cur };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.projectId !== undefined) next.projectId = patch.projectId;     // null detaches
  if (patch.contexts !== undefined) next.contexts = normContexts(patch.contexts);
  if (patch.due !== undefined) next.due = patch.due;                       // null clears
  if (patch.waitingFor !== undefined) next.waitingFor = patch.waitingFor;
  if (patch.flagged !== undefined) next.flagged = !!patch.flagged;
  if (patch.status !== undefined) {
    next.status = patch.status;
    if (patch.status === "done") next.completedAt = cur.completedAt || t;
    else next.completedAt = null;
  }
  next.createdAt = cur.createdAt;
  await applyOps([op("tasks", id, (cur.rev || 1) + 1, t, next)]);
  return read("tasks", id);
}
export async function deleteTask(id: string) {
  const cur = await read("tasks", id); if (!cur) return null;
  const t = now();
  const ops = [op("tasks", id, (cur.rev || 1) + 1, t, cur, t)];          // tombstone
  for (const r of await sql`select * from notes where task_id=${id} and deleted_at is null`) {
    const n: any = ROW_TO_CLIENT.notes(r);
    ops.push(op("notes", n.id, (n.rev || 1) + 1, t, { ...n, taskId: null }));   // detach note from deleted task
  }
  await applyOps(ops);
  return { ok: true, deleted: cur };
}

/* ---------------- PROJECTS ---------------- */
export async function createProject(f: any) {
  const t = now(), id = uid("prj");
  const data = { id, title: f.title || "New project", outcome: f.outcome || "", status: f.status || "active", createdAt: t };
  await applyOps([op("projects", id, 1, t, data)]);
  return read("projects", id);
}
export async function updateProject(id: string, patch: any) {
  const cur = await read("projects", id); if (!cur) return null;
  const t = now();
  const next: any = { ...cur };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.outcome !== undefined) next.outcome = patch.outcome;
  if (patch.status !== undefined) next.status = patch.status;
  next.createdAt = cur.createdAt;
  await applyOps([op("projects", id, (cur.rev || 1) + 1, t, next)]);
  return read("projects", id);
}
export async function deleteProject(id: string) {
  const cur = await read("projects", id); if (!cur) return null;
  const t = now();
  const ops = [op("projects", id, (cur.rev || 1) + 1, t, cur, t)];
  for (const r of await sql`select * from tasks where project_id=${id} and deleted_at is null`) {
    const x: any = ROW_TO_CLIENT.tasks(r); ops.push(op("tasks", x.id, (x.rev || 1) + 1, t, { ...x, projectId: null }));
  }
  for (const r of await sql`select * from notes where project_id=${id} and deleted_at is null`) {
    const x: any = ROW_TO_CLIENT.notes(r); ops.push(op("notes", x.id, (x.rev || 1) + 1, t, { ...x, projectId: null }));
  }
  await applyOps(ops);
  return { ok: true, deleted: cur };
}

/* ---------------- NOTES ---------------- */
export async function createNote(f: any) {
  const t = now(), id = uid("note");
  let projectId = f.projectId ?? null;
  if (!projectId && f.taskId) { const task = await read("tasks", f.taskId); if (task) projectId = task.projectId; }  // inherit task's project
  const data = { id, title: f.title || "", body: f.body || "", tags: normTags(f.tags), projectId, taskId: f.taskId ?? null, createdAt: t };
  await applyOps([op("notes", id, 1, t, data)]);
  return read("notes", id);
}
export async function updateNote(id: string, patch: any) {
  const cur = await read("notes", id); if (!cur) return null;
  const t = now();
  const next: any = { ...cur };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.body !== undefined) next.body = patch.body;
  if (patch.tags !== undefined) next.tags = normTags(patch.tags);
  if (patch.projectId !== undefined) next.projectId = patch.projectId;
  next.createdAt = cur.createdAt;
  await applyOps([op("notes", id, (cur.rev || 1) + 1, t, next)]);
  return read("notes", id);
}
export async function deleteNote(id: string) {
  const cur = await read("notes", id); if (!cur) return null;
  const t = now();
  await applyOps([op("notes", id, (cur.rev || 1) + 1, t, cur, t)]);
  return { ok: true, deleted: cur };
}

/* ---------------- batch complete (explicit ids only, capped) ---------------- */
export async function completeTasks(ids: string[]) {
  const t = now(), ops: any[] = [], updated: any[] = [];
  for (const id of ids.slice(0, 50)) {
    const cur = await read("tasks", id); if (!cur) continue;
    const next = { ...cur, status: "done", completedAt: cur.completedAt || t };
    ops.push(op("tasks", id, (cur.rev || 1) + 1, t, next));
    updated.push(id);
  }
  if (ops.length) await applyOps(ops);
  return Promise.all(updated.map((id) => read("tasks", id)));
}

/* ---------------- reads / queries ---------------- */
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
function matchDue(due: string | null, filter: string) {
  if (filter === "none") return !due;
  if (!due) return false;
  const d = new Date(due), t0 = startOfToday(), t1 = new Date(t0.getTime() + 86400000), t7 = new Date(t0.getTime() + 7 * 86400000);
  if (filter === "overdue") return d < t0;
  if (filter === "today") return d >= t0 && d < t1;
  if (filter === "this_week") return d >= t0 && d <= t7;
  return true; // "any"
}
const orderKey = (t: any) => (t.order != null ? t.order : -(Date.parse(t.createdAt) || 0));
function sortTasks(items: any[], sort?: string) {
  const a = [...items];
  if (sort === "due_asc") a.sort((x, y) => (x.due ? Date.parse(x.due) : Infinity) - (y.due ? Date.parse(y.due) : Infinity));
  else if (sort === "updated_desc") a.sort((x, y) => (y.updatedAt || "").localeCompare(x.updatedAt || ""));
  else if (sort === "manual") a.sort((x, y) => orderKey(x) - orderKey(y));
  else a.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || "")); // created_desc default
  return a;
}

export async function listTasks(f: any = {}) {
  const st = await getState();
  let items = st.tasks;
  if (f.status) items = items.filter((t: any) => t.status === f.status);
  if (f.projectId === "none") items = items.filter((t: any) => !t.projectId);
  else if (f.projectId) items = items.filter((t: any) => t.projectId === f.projectId);
  if (f.context) items = items.filter((t: any) => t.contexts.includes(f.context));
  if (typeof f.flagged === "boolean") items = items.filter((t: any) => !!t.flagged === f.flagged);
  if (f.dueFilter && f.dueFilter !== "any") items = items.filter((t: any) => matchDue(t.due, f.dueFilter));
  if (f.search) {
    const q = f.search.toLowerCase();
    const noteHit = (id: string) => f.searchNotes && st.notes.some((n: any) => n.taskId === id && (n.body || "").toLowerCase().includes(q));
    items = items.filter((t: any) => t.title.toLowerCase().includes(q) || noteHit(t.id));
  }
  return sortTasks(items, f.sort).slice(0, Math.min(f.limit || 50, 200));
}

export async function listProjects(status?: string) {
  const st = await getState();
  let projects = status ? st.projects.filter((p: any) => p.status === status) : st.projects;
  return projects.map((p: any) => {
    const tasks = st.tasks.filter((t: any) => t.projectId === p.id);
    const total = tasks.length, done = tasks.filter((t: any) => t.status === "done").length;
    const next = tasks.find((t: any) => t.status === "next");
    return { ...p, done_count: done, total_count: total, next_action: next ? { id: next.id, title: next.title } : null };
  });
}

export async function listNotes(f: any = {}) {
  const st = await getState();
  let items = st.notes;
  if (f.tag) items = items.filter((n: any) => n.tags.includes(f.tag));
  if (f.projectId === "none") items = items.filter((n: any) => !n.projectId);
  else if (f.projectId) items = items.filter((n: any) => n.projectId === f.projectId);
  if (f.taskId === "none") items = items.filter((n: any) => !n.taskId);
  else if (f.taskId) items = items.filter((n: any) => n.taskId === f.taskId);
  if (f.search) { const q = f.search.toLowerCase(); items = items.filter((n: any) => (n.title || "").toLowerCase().includes(q) || (n.body || "").toLowerCase().includes(q)); }
  return items;
}

export async function getProjectBundle(id: string) {
  const st = await getState();
  const project = st.projects.find((p: any) => p.id === id);
  if (!project) return null;
  return {
    project,
    tasks: st.tasks.filter((t: any) => t.projectId === id),
    notes: st.notes.filter((n: any) => n.projectId === id),
  };
}

export async function summary() {
  const st = await getState();
  const open = (s: string) => st.tasks.filter((t: any) => t.status === s).length;
  const today = new Date().toISOString().slice(0, 10);
  const t0 = startOfToday();
  return {
    inbox: open("inbox"), next: open("next"), waiting: open("waiting"), someday: open("someday"),
    done_today: st.tasks.filter((t: any) => t.status === "done" && t.completedAt && t.completedAt.slice(0, 10) === today).length,
    active_projects: st.projects.filter((p: any) => p.status === "active").length,
    overdue: st.tasks.filter((t: any) => t.status !== "done" && t.due && new Date(t.due) < t0).length,
  };
}

/* similar live tasks (same normalized title) — surfaced on create so the agent can self-correct */
export async function similarTasks(title: string) {
  const q = (title || "").trim().toLowerCase();
  if (!q) return [];
  const st = await getState();
  return st.tasks.filter((t: any) => t.title.trim().toLowerCase() === q);
}

export { read };
