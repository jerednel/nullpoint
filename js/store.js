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

class Store {
  constructor() {
    this.state = load();
    this.subs = new Set();
  }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  _persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); }
    catch (e) { console.warn("persist failed", e); }
  }
  _emit() { this._persist(); this.subs.forEach((fn) => fn(this.state)); }

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
export { uid };
