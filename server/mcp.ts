/* ============================================================
   NULLPOINT // MCP SERVER  (stdio)
   Exposes the GTD board to an LLM agent. Writes go through the same sync path
   the web app uses, so the app picks up agent changes on its next pull.

   Run (e.g. from a Claude Code / openclaw MCP config):
     { "mcpServers": { "nullpoint": {
         "command": "bun",
         "args": ["/Users/jeremy/git/nullpoint/server/mcp.ts"] } } }
   It reads DATABASE_URL from .env (Bun auto-loads). stdout is the MCP channel —
   never console.log here; logs go to stderr.
   ============================================================ */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { migrate } from "./db.ts";
import * as ops from "./store-ops.ts";

/* ---- agent-facing shapes (snake_case, due as YYYY-MM-DD, no internals) ---- */
const dueToISO = (d?: string | null) => (d == null ? null : new Date(d).toISOString());
const shapeTask = (t: any) => t && ({ id: t.id, title: t.title, status: t.status, project_id: t.projectId ?? null, contexts: t.contexts, due: t.due ? String(t.due).slice(0, 10) : null, waiting_for: t.waitingFor, flagged: !!t.flagged, created_at: t.createdAt, updated_at: t.updatedAt, completed_at: t.completedAt ?? null });
const shapeProject = (p: any) => p && ({ id: p.id, title: p.title, outcome: p.outcome, status: p.status, created_at: p.createdAt, updated_at: p.updatedAt, ...(p.done_count != null ? { done_count: p.done_count, total_count: p.total_count, next_action: p.next_action } : {}) });
const shapeNote = (n: any) => n && ({ id: n.id, title: n.title, body: n.body, tags: n.tags, project_id: n.projectId ?? null, task_id: n.taskId ?? null, created_at: n.createdAt, updated_at: n.updatedAt });

const json = (v: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
const notFound = (kind: string, id: string) => fail(`No ${kind} found with id "${id}". Call list_${kind}s to get valid ids.`);

/* ---- shared field schemas ---- */
const TASK_STATUS = z.enum(["inbox", "next", "waiting", "someday", "done"]);
const PROJECT_STATUS = z.enum(["active", "someday", "done"]);
const id = z.string().max(80);
const dueIn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable();

const server = new McpServer({ name: "nullpoint-gtd", version: "1.0.0" });

/* ============================ READ ============================ */

server.registerTool("list_tasks", {
  title: "List / find tasks",
  description:
    "Find and read tasks. This is the ONLY way to read tasks and to discover their ids — call it before any update_task/complete_tasks/delete_task so you have the id. Returns full task objects. Filters combine with AND. Do NOT use to read projects or notes (use list_projects / list_notes), and do NOT use just to count (use get_summary, which is cheaper).",
  inputSchema: {
    status: TASK_STATUS.optional().describe("Filter to one GTD bucket. inbox=captured/unclarified · next=ready next action · waiting=delegated or blocked · someday=incubating · done=completed."),
    project_id: z.string().optional().describe('Tasks in this project. Pass "none" for unfiled tasks (no project).'),
    context: z.string().optional().describe('Exact-match on one @context, e.g. "@computer". Not a substring — use `search` for free text.'),
    flagged: z.boolean().optional().describe("true returns only flagged/focus tasks."),
    due_filter: z.enum(["any", "overdue", "today", "this_week", "none"]).optional().describe("any=no filter · overdue=due before today · today=due today · this_week=due within 7 days · none=no due date. (Computed against the server's local date.)"),
    search: z.string().optional().describe("Case-insensitive substring match on the task title."),
    search_notes: z.boolean().optional().describe("If true, `search` also matches the body of notes attached to a task (helps find tasks with terse titles)."),
    sort: z.enum(["created_desc", "due_asc", "updated_desc", "manual"]).optional().describe("created_desc (default) · due_asc (most urgent first) · updated_desc · manual (the user's drag order)."),
    limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
  },
}, async (a) => json((await ops.listTasks({ status: a.status, projectId: a.project_id, context: a.context, flagged: a.flagged, dueFilter: a.due_filter, search: a.search, searchNotes: a.search_notes, sort: a.sort, limit: a.limit })).map(shapeTask)));

server.registerTool("list_projects", {
  title: "List projects",
  description:
    "List projects with progress. Each row includes done_count and total_count (completed vs total attached tasks) and next_action (the project's current next-action task, or null — a project with next_action=null is STALLED and needs one). status: active=committed/being worked · someday=parked · done=outcome achieved. To read ONE project with its tasks AND notes in a single call, use get_project. To list a project's tasks only, use list_tasks(project_id=<id>).",
  inputSchema: { status: PROJECT_STATUS.optional().describe("Filter by project status.") },
}, async (a) => json((await ops.listProjects(a.status)).map(shapeProject)));

server.registerTool("list_notes", {
  title: "List / find notes",
  description:
    "Find and read reference notes (markdown). This is the ONLY way to read notes and discover their ids. `search` matches BOTH title and body (case-insensitive substring). Do NOT use to read tasks (use list_tasks).",
  inputSchema: {
    tag: z.string().optional().describe('Exact-match on one tag, e.g. "finance" (no # prefix).'),
    project_id: z.string().optional().describe('Notes linked to this project. Pass "none" for notes with no project.'),
    task_id: z.string().optional().describe('Notes captured inside this task. Pass "none" for notes not attached to any task.'),
    search: z.string().optional().describe("Case-insensitive substring match on note title and body."),
  },
}, async (a) => json((await ops.listNotes({ tag: a.tag, projectId: a.project_id, taskId: a.task_id, search: a.search })).map(shapeNote)));

server.registerTool("get_project", {
  title: "Get one project with its tasks and notes",
  description:
    "Read ONE project and everything attached to it (its tasks and notes) in a single call. Use this for 'how is project X going' or 'show me everything in project X'. For just the list of projects, use list_projects.",
  inputSchema: { id: id.describe("The project id (from list_projects).") },
}, async (a) => {
  const b = await ops.getProjectBundle(a.id);
  return b ? json({ project: shapeProject(b.project), tasks: b.tasks.map(shapeTask), notes: b.notes.map(shapeNote) }) : notFound("project", a.id);
});

server.registerTool("get_summary", {
  title: "GTD orientation snapshot (counts only)",
  description:
    "Counts to orient before deciding where to look: inbox/next/waiting/someday = task counts per bucket · done_today = tasks completed today · active_projects = projects with status=active · overdue = tasks past due and not done. Returns NO task titles or ids — you cannot act on its output. To read actual tasks or get ids, use list_tasks.",
  inputSchema: {},
}, async () => json(await ops.summary()));

/* ============================ TASKS (write) ============================ */

server.registerTool("create_task", {
  title: "Capture a new task",
  description:
    "Capture a NEW task (open loop). Do NOT pass an id — one is generated and returned. Do NOT use to edit an existing task — use update_task.\n" +
    "If unsure how to classify it, LEAVE status at the default \"inbox\" (correct for raw capture); do not guess \"next\". Only set status=\"next\" if it is already a concrete, ready physical action (and add `contexts` like [\"@computer\"]). Only set status=\"waiting\" if it is already delegated/blocked (also set `waiting_for`). status=\"done\" auto-stamps the completion time.\n" +
    "The response includes `possible_duplicate_of`: live tasks with the same title — if non-empty, you probably meant to update one of those instead of creating a new row.",
  inputSchema: {
    title: z.string().min(1).describe("Required. The task text."),
    status: TASK_STATUS.optional().describe("Default \"inbox\". See status meanings."),
    project_id: id.optional().describe("Attach to a project (a task belongs to at most one project)."),
    contexts: z.array(z.string()).optional().describe('@contexts describing where/how to act, e.g. ["@computer","@errands"]. Deduped; @ added if missing.'),
    due: dueIn.optional().describe("Due date as YYYY-MM-DD (no time). Omit for no due date."),
    waiting_for: z.string().optional().describe("Who/what is awaited. Set this together with status=\"waiting\"."),
    flagged: z.boolean().optional().describe("true marks the task as focus."),
  },
}, async (a) => {
  const t = await ops.createTask({ title: a.title, status: a.status, projectId: a.project_id, contexts: a.contexts, due: dueToISO(a.due), waitingFor: a.waiting_for, flagged: a.flagged });
  const dupes = await ops.similarTasks(a.title);
  return json({ task: shapeTask(t), possible_duplicate_of: dupes.filter((d: any) => d.id !== t.id).map(shapeTask) });
});

server.registerTool("update_task", {
  title: "Update an existing task (status, fields)",
  description:
    "Change an EXISTING task by id (get the id from list_tasks first). This is the ONLY way to change status or move a task between GTD buckets — there is no complete_task/finish_task/move_task/flag_task tool, they are all update_task with the matching field.\n" +
    "• Complete it: status=\"done\" (auto-stamps completed_at; do NOT delete a task to finish work).\n" +
    "• Defer it: status=\"someday\". • Make it the next action: status=\"next\". • Block/delegate: status=\"waiting\" AND set waiting_for.\n" +
    "Partial update: fields you omit are left unchanged. To CLEAR a field pass null: project_id=null detaches from its project, due=null removes the due date.\n" +
    "WARNING: `contexts` is a WHOLE-ARRAY REPLACE, not a merge — the array you pass becomes the complete new set. To add one @context while keeping the rest, read the task first (list_tasks) and pass the full desired array.\n" +
    "completed_at is read-only (managed by status). Prefer status changes over delete_task for normal flow.",
  inputSchema: {
    id: id.describe("The task id to update."),
    title: z.string().min(1).optional(),
    status: TASK_STATUS.optional().describe("Move to this bucket. \"done\" auto-stamps completion; leaving \"done\" clears it."),
    project_id: id.nullable().optional().describe("Reassign project. null detaches."),
    contexts: z.array(z.string()).optional().describe("REPLACES the whole context list. Pass [] to remove all."),
    due: dueIn.optional().describe("YYYY-MM-DD to set, null to clear, omit to leave unchanged."),
    waiting_for: z.string().optional().describe('Who/what is awaited (pair with status="waiting"). "" clears it.'),
    flagged: z.boolean().optional(),
  },
}, async (a) => {
  const patch: any = {};
  for (const [k, v] of Object.entries({ title: a.title, status: a.status, projectId: a.project_id, waitingFor: a.waiting_for, flagged: a.flagged })) if (v !== undefined) patch[k] = v;
  if (a.contexts !== undefined) patch.contexts = a.contexts;
  if (a.due !== undefined) patch.due = dueToISO(a.due);
  const t = await ops.updateTask(a.id, patch);
  return t ? json(shapeTask(t)) : notFound("task", a.id);
});

server.registerTool("complete_tasks", {
  title: "Mark one or more tasks done",
  description:
    "Mark one OR MANY tasks as done (status=\"done\", auto-stamps completion) in a single call. Use this for any 'mark these done / I finished X, Y, Z' request — pass every id. For a single task it equals update_task(id, status=\"done\"); prefer this whenever more than one task is involved. Only tasks you explicitly list are touched (no bulk-by-filter). Returns the updated tasks.",
  inputSchema: { ids: z.array(id).min(1).max(50).describe("Task ids to complete (read them from list_tasks).") },
}, async (a) => json((await ops.completeTasks(a.ids)).map(shapeTask)));

server.registerTool("delete_task", {
  title: "Delete a task (soft, reversible)",
  description:
    "SOFT-delete a task: it is hidden everywhere but the row is kept and CAN be restored (call update_task on the same id to revert). Notes captured inside it are detached (their task link is cleared) but survive as standalone notes.\n" +
    "PREFER status changes for normal GTD flow: a finished task is update_task(status=\"done\"); something you've abandoned is update_task(status=\"someday\"). Use delete_task ONLY for genuine junk — a typo capture or accidental duplicate that should leave no trace. When unsure between delete and done, choose done.\n" +
    "Returns the tombstoned task so you can confirm what was removed.",
  inputSchema: { id: id.describe("The task id to delete.") },
}, async (a) => { const r = await ops.deleteTask(a.id); return r ? json({ deleted: true, task: shapeTask(r.deleted) }) : notFound("task", a.id); });

/* ============================ PROJECTS (write) ============================ */

server.registerTool("create_project", {
  title: "Create a project",
  description:
    "Create a NEW project — an outcome that needs MORE THAN ONE action. Set `outcome` to what 'done' looks like. status defaults to \"active\". Do NOT use for single tasks (use create_task) or to edit an existing project (use update_project). After creating, capture its first next action with create_task(project_id=<new id>, status=\"next\").",
  inputSchema: {
    title: z.string().min(1).describe("Required. The project name."),
    outcome: z.string().optional().describe("What success looks like (the desired result)."),
    status: PROJECT_STATUS.optional().describe("active (default) · someday (parked) · done (achieved)."),
  },
}, async (a) => json(shapeProject(await ops.createProject({ title: a.title, outcome: a.outcome, status: a.status }))));

server.registerTool("update_project", {
  title: "Update a project",
  description:
    "Change an EXISTING project by id (from list_projects). Use status=\"done\" to wrap up a FINISHED project — this keeps the project and its task links for history; do NOT delete_project to finish one. Partial update: omitted fields unchanged.",
  inputSchema: {
    id: id.describe("The project id."),
    title: z.string().min(1).optional(),
    outcome: z.string().optional(),
    status: PROJECT_STATUS.optional().describe('"done" archives a finished project (preferred over deleting).'),
  },
}, async (a) => {
  const patch: any = {};
  for (const [k, v] of Object.entries({ title: a.title, outcome: a.outcome, status: a.status })) if (v !== undefined) patch[k] = v;
  const p = await ops.updateProject(a.id, patch);
  return p ? json(shapeProject(p)) : notFound("project", a.id);
});

server.registerTool("delete_project", {
  title: "Delete a project (soft; detaches children)",
  description:
    "SOFT-delete a project. Its tasks and notes are NOT deleted — they are DETACHED (project link cleared) and survive as loose items. This is usually NOT what you want: to wrap up a finished project use update_project(status=\"done\"), which keeps the structure intact. Use delete_project only to discard a mis-created project. Returns the tombstoned project.",
  inputSchema: { id: id.describe("The project id to delete.") },
}, async (a) => { const r = await ops.deleteProject(a.id); return r ? json({ deleted: true, project: shapeProject(r.deleted) }) : notFound("project", a.id); });

/* ============================ NOTES (write) ============================ */

server.registerTool("create_note", {
  title: "Create a reference note",
  description:
    "Capture reference material (markdown body). Set EXACTLY ONE link, or none: project_id links it to a project; task_id links it to the task it was captured inside; leave both null for a standalone note. `tags` are plain keywords like [\"reference\",\"finance\"] — NOT @contexts (contexts belong on tasks). Do NOT use to capture an action you need to DO — that's a task (create_task). A blank note (no title/body) is still valid capture.",
  inputSchema: {
    title: z.string().optional().describe("Optional short title."),
    body: z.string().optional().describe("Markdown body."),
    tags: z.array(z.string()).optional().describe('Keyword tags (no # prefix), e.g. ["finance"].'),
    project_id: id.optional().describe("Link to a project."),
    task_id: id.optional().describe("Link to the task it was captured in (inherits that task's project)."),
  },
}, async (a) => json(shapeNote(await ops.createNote({ title: a.title, body: a.body, tags: a.tags, projectId: a.project_id, taskId: a.task_id }))));

server.registerTool("update_note", {
  title: "Update a note",
  description:
    "Edit an EXISTING note by id (from list_notes). `tags` REPLACES the whole tag list (read first to add one). project_id and task_id re-link the note; pass null to unlink (e.g. task_id=null detaches it from the task it was captured in). Partial update: omitted fields unchanged.",
  inputSchema: {
    id: id.describe("The note id."),
    title: z.string().optional(),
    body: z.string().optional().describe("Markdown body (replaces the whole body)."),
    tags: z.array(z.string()).optional().describe("REPLACES the whole tag list. Pass [] to remove all."),
    project_id: id.nullable().optional().describe("Re-link to a project; null unlinks."),
    task_id: id.nullable().optional().describe("Re-link to a task; null unlinks."),
  },
}, async (a) => {
  const patch: any = {};
  for (const [k, v] of Object.entries({ title: a.title, body: a.body, projectId: a.project_id, taskId: a.task_id })) if (v !== undefined) patch[k] = v;
  if (a.tags !== undefined) patch.tags = a.tags;
  const n = await ops.updateNote(a.id, patch);
  return n ? json(shapeNote(n)) : notFound("note", a.id);
});

server.registerTool("delete_note", {
  title: "Delete a note (soft, reversible)",
  description:
    "SOFT-delete a note (hidden but restorable via update_note on the same id). Use only to discard junk; there is no archive status for notes. Returns the tombstoned note.",
  inputSchema: { id: id.describe("The note id to delete.") },
}, async (a) => { const r = await ops.deleteNote(a.id); return r ? json({ deleted: true, note: shapeNote(r.deleted) }) : notFound("note", a.id); });

/* ---- boot ---- */
await migrate();
await server.connect(new StdioServerTransport());
console.error("◈ NULLPOINT MCP server ready (stdio)");
