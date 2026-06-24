/* ============================================================
   NULLPOINT // STORE
   Single source of truth. localStorage-backed, pub/sub.

   Data model
   ----------
   task    { id, title, status, projectId, contexts[], noteIds[],
             due, waitingFor, flagged, createdAt, updatedAt, completedAt }
            status ∈ inbox | next | waiting | someday | done
   project { id, title, outcome, status, noteIds[], createdAt, updatedAt }
            status ∈ active | someday | done
   note    { id, title, body, tags[], projectId, taskId,
             createdAt, updatedAt }
   ============================================================ */

const KEY = "nullpoint.gtd.v1";

const uid = (p = "id") =>
  p + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

const now = () => new Date().toISOString();

/* Manual sort key (ascending = top). Tasks only carry an explicit `order` once
   they've been dragged; otherwise it falls back to -createdAt so the default is
   newest-first and every device computes the same baseline without a backfill. */
const orderKey = (t) => (t && t.order != null ? t.order : -(Date.parse(t && t.createdAt) || 0));

const blank = () => ({ tasks: [], projects: [], notes: [], meta: { created: now() } });

/* ---- seed: a believable starting board so the app feels alive ---- */
function seed() {
  const t = now();
  const pLaunch = uid("prj");
  const pHealth = uid("prj");
  const nLaunch = uid("note");
  const nApi = uid("note");

  return {
    meta: { created: t, seeded: true },
    projects: [
      { id: pLaunch, title: "Ship NULLPOINT v1", outcome: "Public, polished GTD build deployed and documented.", status: "active", noteIds: [nLaunch], createdAt: t, updatedAt: t },
      { id: pHealth, title: "Reset sleep schedule", outcome: "In bed by 23:30 for two weeks straight.", status: "active", noteIds: [], createdAt: t, updatedAt: t },
    ],
    tasks: [
      { id: uid("tsk"), title: "Buy blue-light glasses", status: "next", projectId: pHealth, contexts: ["@errands"], noteIds: [], due: null, waitingFor: "", flagged: false, createdAt: t, updatedAt: t },
      { id: uid("tsk"), title: "Write the README + screenshots", status: "next", projectId: pLaunch, contexts: ["@computer"], noteIds: [nApi], due: null, waitingFor: "", flagged: true, createdAt: t, updatedAt: t },
      { id: uid("tsk"), title: "Draft launch tweet thread", status: "next", projectId: pLaunch, contexts: ["@computer","@creative"], noteIds: [], due: null, waitingFor: "", flagged: false, createdAt: t, updatedAt: t },
      { id: uid("tsk"), title: "Hear back from design review", status: "waiting", projectId: pLaunch, contexts: [], noteIds: [], due: null, waitingFor: "Mara", flagged: false, createdAt: t, updatedAt: t },
      { id: uid("tsk"), title: "Read 'Getting Things Done' again", status: "someday", projectId: null, contexts: ["@anywhere"], noteIds: [], due: null, waitingFor: "", flagged: false, createdAt: t, updatedAt: t },
      { id: uid("tsk"), title: "Idea: voice capture via Web Speech API", status: "inbox", projectId: null, contexts: [], noteIds: [], due: null, waitingFor: "", flagged: false, createdAt: t, updatedAt: t },
      { id: uid("tsk"), title: "Call dentist about that filling", status: "inbox", projectId: null, contexts: [], noteIds: [], due: null, waitingFor: "", flagged: false, createdAt: t, updatedAt: t },
    ],
    notes: [
      { id: nLaunch, title: "Design north star", body: "Cyberpunk but LEGIBLE. Neon is an accent, never the body copy. Hard edges, scanlines, motion blur on transitions. Dark near-black canvas.", tags: ["design","principles"], projectId: pLaunch, taskId: null, createdAt: t, updatedAt: t },
      { id: nApi, title: "README outline", body: "1. What is GTD\n2. The five steps as implemented\n3. Keyboard shortcuts\n4. Data lives in your browser (localStorage)\n5. Export / import", tags: ["docs"], projectId: pLaunch, taskId: null, createdAt: t, updatedAt: t },
    ],
  };
}

/* ---- load / persist ---- */
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seed();
    const data = JSON.parse(raw);
    // shallow integrity guard
    for (const k of ["tasks", "projects", "notes"]) if (!Array.isArray(data[k])) data[k] = [];
    return data;
  } catch {
    return seed();
  }
}

const ENTITIES = [["tasks", "tasks"], ["projects", "projects"], ["notes", "notes"]];
const VOLATILE = new Set(["rev", "updatedAt", "deletedAt"]);
const clone = (x) => (typeof structuredClone === "function" ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
function meaningful(e) {
  // JSON of an entity ignoring volatile fields, key-order-independent, so two
  // equal-by-content entities compare equal regardless of property order.
  const o = {};
  for (const k of Object.keys(e).filter((k) => !VOLATILE.has(k)).sort()) o[k] = e[k];
  return JSON.stringify(o);
}

class Store {
  constructor() {
    this.state = load();
    for (const [k] of ENTITIES) for (const e of this.state[k]) if (e.rev == null) e.rev = 1;
    this.subs = new Set();
    this._sink = null;          // sync layer registers an op consumer here
    this._muteCapture = false;  // true while applying authoritative server rows
    this._shadow = this._shadowOf(this.state);
  }
  _shadowOf(state) {
    const s = {};
    for (const [k] of ENTITIES) { s[k] = new Map(); for (const e of state[k]) s[k].set(e.id, clone(e)); }
    return s;
  }
  setSyncSink(fn) { this._sink = fn; }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  _persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); }
    catch (e) { console.warn("persist failed", e); }
  }
  /* THE op-capture point. Diff state vs shadow → full-row upsert for every
     changed entity, tombstone for every vanished id. Because this is the only
     capture point, cascade side-effects (deleteTask nulls note.taskId,
     deleteProject detaches tasks+notes, addNote/updateNote rewrite noteIds) and
     wholesale replaces (import/reset/loadDemo) are all captured automatically,
     each as a FULL snapshot (never a patch), with rev + updatedAt stamped here
     so siblings advance too. */
  _captureChanges() {
    if (this._muteCapture || !this._sink) return;
    const ops = [], t = now();
    for (const [k, entity] of ENTITIES) {
      const shadow = this._shadow[k], seen = new Set();
      for (const e of this.state[k]) {
        seen.add(e.id);
        const prev = shadow.get(e.id);
        if (prev && meaningful(prev) === meaningful(e)) continue;
        e.rev = prev ? (prev.rev || 1) + 1 : (e.rev || 1);
        e.updatedAt = t;
        ops.push({ entity, id: e.id, rev: e.rev, updatedAt: t, deletedAt: null, data: clone(e) });
      }
      for (const [id, prev] of shadow) {
        if (seen.has(id)) continue;
        const rev = (prev.rev || 1) + 1;
        ops.push({ entity, id, rev, updatedAt: t, deletedAt: t, data: { ...clone(prev), rev, updatedAt: t, deletedAt: t } });
      }
    }
    if (ops.length) this._sink(ops);
    this._shadow = this._shadowOf(this.state);
  }
  _emit() { this._captureChanges(); this._persist(); this.subs.forEach((fn) => fn(this.state)); }

  /* ---- sync integration ---- */
  hasData() { return this.state.tasks.length + this.state.projects.length + this.state.notes.length > 0; }
  snapshotOps() {              // all rows as upserts — used for first-run push when server is empty
    const ops = [];
    for (const [k, entity] of ENTITIES)
      for (const e of this.state[k]) { if (e.rev == null) e.rev = 1; ops.push({ entity, id: e.id, rev: e.rev, updatedAt: e.updatedAt, deletedAt: null, data: clone(e) }); }
    return ops;
  }
  applyRemote(rows) {          // merge authoritative rows by LWW, no echo back to the queue
    this._muteCapture = true;
    let changed = false;
    for (const [k] of ENTITIES) {
      for (const r of (rows[k] || [])) {
        const arr = this.state[k], i = arr.findIndex((x) => x.id === r.id), local = i >= 0 ? arr[i] : null;
        if (local && !(r.rev > local.rev || (r.rev === local.rev && (r.updatedAt || "") > (local.updatedAt || "")))) continue;
        if (r.deletedAt) { if (i >= 0) { arr.splice(i, 1); changed = true; } }
        else { const e = clone(r); delete e.deletedAt; if (i >= 0) arr[i] = e; else arr.unshift(e); changed = true; }
      }
    }
    this._shadow = this._shadowOf(this.state);
    this._muteCapture = false;
    if (changed) { this._persist(); this.subs.forEach((fn) => fn(this.state)); }
    return changed;
  }
  replaceAll(rows) {           // replace local with server snapshot (first-load reconcile, after local is flushed)
    this._muteCapture = true;
    for (const [k] of ENTITIES) this.state[k] = (rows[k] || []).map(clone);
    this._shadow = this._shadowOf(this.state);
    this._muteCapture = false;
    this._persist();
    this.subs.forEach((fn) => fn(this.state));
  }

  /* getters */
  get tasks() { return this.state.tasks; }
  get projects() { return this.state.projects; }
  get notes() { return this.state.notes; }
  task(id) { return this.state.tasks.find((t) => t.id === id); }
  project(id) { return this.state.projects.find((p) => p.id === id); }
  note(id) { return this.state.notes.find((n) => n.id === id); }

  /* ---------- TASKS ---------- */
  addTask(fields = {}) {
    const t = now();
    const task = {
      id: uid("tsk"), title: "Untitled", status: "inbox", projectId: null,
      contexts: [], noteIds: [], due: null, waitingFor: "", flagged: false,
      createdAt: t, updatedAt: t, completedAt: null, ...fields,
    };
    this.state.tasks.unshift(task);
    this._emit();
    return task;
  }
  updateTask(id, patch) {
    const tsk = this.task(id); if (!tsk) return;
    Object.assign(tsk, patch, { updatedAt: now() });
    if (patch.status === "done" && !tsk.completedAt) tsk.completedAt = now();
    if (patch.status && patch.status !== "done") tsk.completedAt = null;
    this._emit();
  }
  toggleTask(id) {
    const tsk = this.task(id); if (!tsk) return;
    this.updateTask(id, { status: tsk.status === "done" ? "next" : "done" });
  }
  /* Move one task between its new visual neighbors. In the normal case this
     changes ONLY the moved task (to the midpoint of its neighbors' keys), so a
     reorder inside a filtered/overlapping view never disturbs tasks hidden from
     that view. The neighbors only collide (bk >= ak) when the visible list isn't
     yet strictly keyed — i.e. the seed, where every task shares one createdAt —
     and only then do we renumber the whole visible list once to make keys distinct.
     `orderedIds` is the full visible order, used solely for that fallback. */
  moveTask(id, beforeId, afterId, orderedIds) {
    const t = this.task(id); if (!t) return;
    const bk = beforeId ? orderKey(this.task(beforeId)) : null;
    const ak = afterId ? orderKey(this.task(afterId)) : null;
    if (bk != null && ak != null && bk >= ak) return this._renumber(orderedIds);
    let order;
    if (bk == null && ak == null) return;
    else if (bk == null) order = ak - 1;        // dropped at top
    else if (ak == null) order = bk + 1;        // dropped at bottom
    else order = (bk + ak) / 2;                 // between two distinct neighbors
    if (order !== orderKey(t)) this.updateTask(id, { order });
  }
  _renumber(orderedIds) {
    const tasks = (orderedIds || []).map((id) => this.task(id)).filter(Boolean);
    if (tasks.length < 2) return;
    const keys = tasks.map(orderKey);
    const base = Math.min(...keys), span = Math.max(...keys) - base;
    const step = span >= tasks.length - 1 ? span / (tasks.length - 1) : 1;
    let changed = false;
    tasks.forEach((t, i) => { const o = base + i * step; if (t.order !== o) { t.order = o; changed = true; } });
    if (changed) this._emit();
  }
  deleteTask(id) {
    const tsk = this.task(id); if (!tsk) return;
    // notes that lived only in this task's context become orphaned standalone notes
    this.state.tasks = this.state.tasks.filter((x) => x.id !== id);
    this.state.notes.forEach((n) => { if (n.taskId === id) n.taskId = null; });
    this._emit();
  }

  /* ---------- PROJECTS ---------- */
  addProject(fields = {}) {
    const t = now();
    const p = { id: uid("prj"), title: "New project", outcome: "", status: "active", noteIds: [], createdAt: t, updatedAt: t, ...fields };
    this.state.projects.unshift(p);
    this._emit();
    return p;
  }
  updateProject(id, patch) {
    const p = this.project(id); if (!p) return;
    Object.assign(p, patch, { updatedAt: now() });
    this._emit();
  }
  deleteProject(id) {
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    // detach tasks & notes (keep them, drop the link)
    this.state.tasks.forEach((t) => { if (t.projectId === id) t.projectId = null; });
    this.state.notes.forEach((n) => { if (n.projectId === id) n.projectId = null; });
    this._emit();
  }
  projectTasks(id) { return this.state.tasks.filter((t) => t.projectId === id); }

  /* ---------- NOTES ---------- */
  addNote(fields = {}) {
    const t = now();
    const note = { id: uid("note"), title: "", body: "", tags: [], projectId: null, taskId: null, createdAt: t, updatedAt: t, ...fields };
    this.state.notes.unshift(note);
    // link to task if provided
    if (note.taskId) {
      const tsk = this.task(note.taskId);
      if (tsk && !tsk.noteIds.includes(note.id)) tsk.noteIds.push(note.id);
      // inherit the task's project so it files correctly in Notes
      if (tsk && tsk.projectId && !note.projectId) note.projectId = tsk.projectId;
    }
    if (note.projectId) {
      const p = this.project(note.projectId);
      if (p && !p.noteIds.includes(note.id)) p.noteIds.push(note.id);
    }
    this._emit();
    return note;
  }
  updateNote(id, patch) {
    const n = this.note(id); if (!n) return;
    const prevProject = n.projectId;
    Object.assign(n, patch, { updatedAt: now() });
    // keep project.noteIds in sync if project changed
    if (patch.projectId !== undefined && patch.projectId !== prevProject) {
      const old = this.project(prevProject); if (old) old.noteIds = old.noteIds.filter((x) => x !== id);
      const np = this.project(n.projectId); if (np && !np.noteIds.includes(id)) np.noteIds.push(id);
    }
    this._emit();
  }
  deleteNote(id) {
    this.state.notes = this.state.notes.filter((n) => n.id !== id);
    this.state.tasks.forEach((t) => { t.noteIds = t.noteIds.filter((x) => x !== id); });
    this.state.projects.forEach((p) => { p.noteIds = p.noteIds.filter((x) => x !== id); });
    this._emit();
  }
  taskNotes(taskId) { return this.state.notes.filter((n) => n.taskId === taskId); }

  /* ---------- DERIVED ---------- */
  allTags() {
    const s = new Set();
    this.state.notes.forEach((n) => n.tags.forEach((tag) => s.add(tag)));
    return [...s].sort();
  }
  allContexts() {
    const s = new Set();
    this.state.tasks.forEach((t) => t.contexts.forEach((c) => s.add(c)));
    return [...s].sort();
  }
  counts() {
    const open = (s) => this.state.tasks.filter((t) => t.status === s).length;
    return {
      inbox: open("inbox"), next: open("next"), waiting: open("waiting"),
      someday: open("someday"),
      projects: this.state.projects.filter((p) => p.status === "active").length,
      notes: this.state.notes.length,
      doneToday: this.state.tasks.filter((t) => t.status === "done" && t.completedAt && t.completedAt.slice(0,10) === now().slice(0,10)).length,
    };
  }

  /* ---------- IO ---------- */
  export() { return JSON.stringify(this.state, null, 2); }
  import(json) {
    const data = JSON.parse(json);
    for (const k of ["tasks", "projects", "notes"]) if (!Array.isArray(data[k])) throw new Error("invalid file");
    this.state = data;
    this._emit();
  }
  reset() { this.state = blank(); this._emit(); }
  loadDemo() { this.state = seed(); this._emit(); }
}

export const store = new Store();
export { uid, orderKey };
