/* ============================================================
   NULLPOINT // VIEWS
   Each export renders into the #view container.
   ============================================================ */
import { store, orderKey } from "./store.js";
import { el, clear, fmtDate, isOverdue, toast, escapeHtml } from "./dom.js";
import { openTask, openNote, openProject } from "./drawer.js";
import { sortableList } from "./sortable.js";

const byOrder = (a, b) => orderKey(a) - orderKey(b);
/* attach drag-reorder to a freshly-built panel's body */
function reorderable(panelEl) {
  const body = panelEl.querySelector(".panel__body");
  if (body) sortableList(body, (id, before, after) => {
    const ids = [...body.children].filter((c) => c.classList?.contains("task")).map((c) => c.dataset.id);
    store.moveTask(id, before, after, ids);
  });
  return panelEl;
}

/* ---------- shared task row ---------- */
function taskRow(task, { showProject = true, clarify = false, drag = false } = {}) {
  const node = el("div.task" + (task.status === "done" ? ".is-done" : ""), { dataset: { id: task.id } });

  const handle = drag ? el("button.drag-handle", { type: "button", html: "⠿", title: "Drag to reorder", "aria-label": "Drag to reorder" }) : null;

  const check = el("button.task__check", { html: "✓", "aria-label": "Toggle done", onClick: () => { store.toggleTask(task.id); toast(task.status === "done" ? "Reopened" : "Done ✓"); } });

  const title = el("div.task__title", { text: task.title, onClick: () => openTask(task.id) });

  const meta = el("div.task__meta");
  if (task.flagged) meta.append(el("span.chip", { html: "★", style: "color:var(--amber);border-color:rgba(255,182,39,.4)" }));
  const proj = showProject && task.projectId ? store.project(task.projectId) : null;
  if (proj) meta.append(el("span.chip.chip--proj", { text: "◇ " + proj.title, onClick: () => openProject(proj.id), class: "chip chip--proj is-btn" }));
  task.contexts.forEach((c) => meta.append(el("span.chip.chip--ctx", { text: c })));
  if (task.status === "waiting" && task.waitingFor) meta.append(el("span.chip", { text: "⧖ " + task.waitingFor, style: "color:var(--violet)" }));
  if (task.due) meta.append(el("span", { class: "chip chip--due" + (isOverdue(task.due) ? " overdue" : ""), text: "▣ " + fmtDate(task.due) }));
  const nNotes = store.taskNotes(task.id).length;
  if (nNotes) meta.append(el("span.chip.chip--note", { text: `✎ ${nNotes}`, title: `${nNotes} note(s)` }));

  const main = el("div.task__main", {}, [title, meta.children.length ? meta : ""]);

  /* clarify quick-actions for inbox processing */
  if (clarify) {
    const bar = el("div.clarify");
    const mk = (label, patch, color) => el("button", { class: "chip is-btn", text: label, style: color ? `color:${color}` : "", onClick: () => { store.updateTask(task.id, patch); toast("Clarified → " + label); } });
    bar.append(
      mk("→ next", { status: "next" }, "var(--lime)"),
      mk("→ waiting", { status: "waiting" }, "var(--violet)"),
      mk("→ someday", { status: "someday" }, "var(--cyan)"),
      el("button", { class: "chip is-btn", text: "→ project", style: "color:var(--violet)", onClick: () => { const p = store.addProject({ title: task.title }); store.deleteTask(task.id); openProject(p.id); toast("Promoted to project"); } }),
      el("button", { class: "chip is-btn", text: "✎ note", style: "color:var(--amber)", onClick: () => { const n = store.addNote({ title: task.title }); store.deleteTask(task.id); openNote(n.id); toast("Filed as reference note"); } }),
    );
    main.append(bar);
  }

  const actions = el("div.task__actions", {}, [
    el("button.icon-btn", { html: task.flagged ? "★" : "☆", title: "Flag", onClick: () => { store.updateTask(task.id, { flagged: !task.flagged }); } }),
    el("button.icon-btn", { html: "✎", title: "Open", onClick: () => openTask(task.id) }),
    el("button.icon-btn.danger", { html: "✕", title: "Delete", onClick: () => { store.deleteTask(task.id); toast("Deleted"); } }),
  ]);

  if (handle) node.append(handle);
  node.append(check, main, actions);
  return node;
}

function head(title, icon, sub, actions = []) {
  return el("div.view-head", {}, [
    el("div.view-head__row", {}, [
      el("h1.view-title", {}, [el("span.tag-icon", { text: icon }), el("span", { text: title })]),
      actions.length ? el("div.view-head__actions", {}, actions) : "",
    ]),
    sub ? el("div.view-sub", { html: sub }) : "",
  ]);
}

function empty(icon, title, hint) {
  return el("div.empty", {}, [
    el("div.empty__icon", { text: icon }),
    el("div.empty__title", { text: title }),
    hint ? el("div.empty__hint", { html: hint }) : "",
  ]);
}

function panel(label, count, accent, body) {
  const p = el("div.panel" + (accent ? ".panel--accent" : ""));
  if (accent) p.style.setProperty("--accent", accent);
  p.append(
    el("div.panel__head", {}, [el("span", { text: label }), el("span.count", { text: `[${count}]` })]),
    el("div.panel__body", {}, body),
  );
  return p;
}

/* ===================== DASHBOARD ===================== */
export function dashboard(mount) {
  const c = store.counts();
  const stats = el("div.stats", {}, [
    statCard(c.inbox, "Inbox", "var(--magenta)"),
    statCard(c.next, "Next actions", "var(--cyan)"),
    statCard(c.waiting, "Waiting", "var(--violet)"),
    statCard(c.projects, "Active projects", "var(--lime)"),
    statCard(c.doneToday, "Done today", "var(--amber)"),
  ]);

  const flagged = store.tasks.filter((t) => t.flagged && t.status !== "done").sort(byOrder);
  const dueSoon = store.tasks
    .filter((t) => t.due && t.status !== "done")
    .sort((a, b) => a.due.localeCompare(b.due));
  const blocked = store.tasks.filter((t) => t.status === "waiting").sort(byOrder);

  const cols = el("div.grid.grid--2", {}, [
    reorderable(panel("⚑ Flagged / focus", flagged.length, "var(--amber)",
      flagged.length ? flagged.map((t) => taskRow(t, { drag: true })) : [empty("◇", "Nothing flagged", "Flag a task to spotlight it here")])),
    panel("▣ Scheduled", dueSoon.length, "var(--cyan)",
      dueSoon.length ? dueSoon.map((t) => taskRow(t)) : [empty("▤", "No dates set", "Add a due date from any task")]),
  ]);

  mount.append(
    head("DASHBOARD", "▚", `${greeting()} — ${c.inbox} to clarify, ${c.next} ready to engage.`),
    stats,
    c.inbox ? el("div", { style: "margin-bottom:22px" }, [
      panel("⬇ Process your inbox", c.inbox, "var(--magenta)", store.tasks.filter((t) => t.status === "inbox").slice(0, 4).map((t) => taskRow(t, { clarify: true })))
    ]) : "",
    cols,
    el("div", { style: "margin-top:22px" }, [
      reorderable(panel("⧖ Waiting / blocked", blocked.length, "var(--violet)",
        blocked.length ? blocked.map((t) => taskRow(t, { drag: true }))
          : [empty("⧖", "Nothing blocked", "Tasks you mark as ‘waiting’ surface here so they don't fall through")])),
    ]),
  );
}
function statCard(num, label, color) {
  const s = el("div.stat"); s.style.setProperty("--accent", color);
  s.append(el("div.stat__num", { text: String(num) }), el("div.stat__label", { text: label }));
  return s;
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/* ===================== INBOX (CAPTURE) ===================== */
export function inbox(mount) {
  const items = store.tasks.filter((t) => t.status === "inbox").sort(byOrder);
  mount.append(
    head("INBOX", "⬇", "Capture everything, decide nothing yet. <b>Clarify</b> each item into a next action, project, someday, or reference note. <span class='hint-kbd'>C</span> to capture from anywhere."),
    items.length
      ? reorderable(el("div.panel", {}, [el("div.panel__body", {}, items.map((t) => taskRow(t, { clarify: true, drag: true })))]))
      : empty("◇", "Inbox zero", "Your mind is clear. Capture the next open loop above."),
  );
}

/* ===================== NEXT ACTIONS ===================== */
let ctxFilter = null;
export function nextActions(mount) {
  let items = store.tasks.filter((t) => t.status === "next");
  const contexts = store.allContexts();

  const bar = el("div.filterbar", {}, [el("span.filterbar__label", { text: "context:" })]);
  bar.append(filterChip("all", ctxFilter === null, () => { ctxFilter = null; rerender(mount, nextActions); }));
  contexts.forEach((c) => bar.append(filterChip(c, ctxFilter === c, () => { ctxFilter = ctxFilter === c ? null : c; rerender(mount, nextActions); }, "var(--lime)")));

  if (ctxFilter) items = items.filter((t) => t.contexts.includes(ctxFilter));
  items.sort(byOrder);   // manual order (drag to reorder)

  mount.append(
    head("NEXT ACTIONS", "→", "The next physical, visible action for each open loop. Filter by context to match your situation. Drag <span class='hint-kbd'>⠿</span> to reorder."),
    contexts.length ? bar : "",
    items.length
      ? reorderable(el("div.panel.panel--accent", { style: "--accent:var(--cyan)" }, [el("div.panel__body", {}, items.map((t) => taskRow(t, { drag: true })))]))
      : empty("→", ctxFilter ? `Nothing in ${ctxFilter}` : "No next actions", "Promote something from your inbox, or capture a new action"),
  );
}

/* ===================== WAITING FOR ===================== */
export function waiting(mount) {
  const items = store.tasks.filter((t) => t.status === "waiting").sort(byOrder);
  mount.append(
    head("WAITING FOR", "⧖", "Delegated or blocked. Track who or what you're waiting on so nothing falls through."),
    items.length
      ? reorderable(el("div.panel.panel--accent", { style: "--accent:var(--violet)" }, [el("div.panel__body", {}, items.map((t) => taskRow(t, { drag: true })))]))
      : empty("⧖", "Not waiting on anyone", "Mark a task as 'waiting' when you've handed it off"),
  );
}

/* ===================== SOMEDAY / MAYBE ===================== */
export function someday(mount) {
  const items = store.tasks.filter((t) => t.status === "someday").sort(byOrder);
  mount.append(
    head("SOMEDAY / MAYBE", "✶", "Incubating ideas and not-now commitments. Review periodically and pull into action when the time is right."),
    items.length
      ? reorderable(el("div.panel", {}, [el("div.panel__body", {}, items.map((t) => taskRow(t, { drag: true })))]))
      : empty("✶", "No someday items", "Park ideas here to revisit later without losing them"),
  );
}

/* ===================== PROJECTS ===================== */
export function projects(mount) {
  const active = store.projects.filter((p) => p.status === "active");
  const others = store.projects.filter((p) => p.status !== "active");

  const addBtn = el("button.btn.btn--primary", { html: "+ new project", onClick: () => { const p = store.addProject(); openProject(p.id); } });

  const card = (p) => {
    const tasks = store.projectTasks(p);
    const open = tasks.filter((t) => t.status !== "done");
    const done = tasks.length - open.length;
    const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    const next = open.find((t) => t.status === "next");
    const c = el("div.card");
    c.append(el("div.card__bar", { style: p.status === "done" ? "background:var(--ink-faint);box-shadow:none" : "" }));
    c.append(el("div.card__title", { text: "◇ " + p.title, onClick: () => openProject(p.id) }));
    if (p.outcome) c.append(el("div.card__desc", { text: p.outcome }));
    if (next) c.append(el("div", { class: "task__meta", style: "margin-top:12px" }, [el("span.chip.chip--ctx", { text: "next: " + next.title })]));
    c.append(el("div.card__foot", {}, [
      el("span", { text: `${done}/${tasks.length}` }),
      el("div.progress", {}, [el("div.progress__fill", { style: `width:${pct}%` })]),
      el("span", { text: pct + "%" }),
    ]));
    return c;
  };

  mount.append(
    head("PROJECTS", "◇", "Any outcome that needs more than one action. Define the win, then keep one next action moving.", [addBtn]),
    active.length ? el("div.grid.grid--cards", {}, active.map(card)) : empty("◇", "No active projects", "Create one, or promote an inbox item into a project"),
    others.length ? el("div", {}, [
      el("div.nav__sep", { text: "// archived & someday", style: "margin-left:0" }),
      el("div.grid.grid--cards", {}, others.map(card)),
    ]) : "",
  );
}

/* ===================== NOTES ===================== */
let noteTagFilter = null, noteProjFilter = null;
export function notes(mount) {
  let items = [...store.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const tags = store.allTags();
  const projs = store.projects;

  const presetProj = noteProjFilter && noteProjFilter !== "__none__" ? noteProjFilter : null;
  const addBtn = el("button.btn.btn--primary", { html: "+ new note", onClick: () => { const n = store.addNote({ title: "Untitled note", projectId: presetProj }); openNote(n.id); } });

  const tagBar = el("div.filterbar", {}, [el("span.filterbar__label", { text: "tag:" }),
    filterChip("all", noteTagFilter === null, () => { noteTagFilter = null; rerender(mount, notes); }, "var(--cyan)"),
    ...tags.map((t) => filterChip("#" + t, noteTagFilter === t, () => { noteTagFilter = noteTagFilter === t ? null : t; rerender(mount, notes); }, "var(--cyan)")),
  ]);
  const projBar = el("div.filterbar", {}, [el("span.filterbar__label", { text: "project:" }),
    filterChip("all", noteProjFilter === null, () => { noteProjFilter = null; rerender(mount, notes); }, "var(--violet)"),
    ...projs.map((p) => filterChip(p.title, noteProjFilter === p.id, () => { noteProjFilter = noteProjFilter === p.id ? null : p.id; rerender(mount, notes); }, "var(--violet)")),
    filterChip("⊘ unfiled", noteProjFilter === "__none__", () => { noteProjFilter = noteProjFilter === "__none__" ? null : "__none__"; rerender(mount, notes); }, "var(--ink-faint)"),
  ]);

  if (noteTagFilter) items = items.filter((n) => n.tags.includes(noteTagFilter));
  if (noteProjFilter === "__none__") items = items.filter((n) => !n.projectId);
  else if (noteProjFilter) items = items.filter((n) => n.projectId === noteProjFilter);

  const card = (n) => {
    const proj = n.projectId ? store.project(n.projectId) : null;
    const src = n.taskId ? store.task(n.taskId) : null;
    const c = el("div.note-card", { onClick: (e) => { if (e.target.closest(".is-btn")) return; openNote(n.id); } });
    c.append(el("div.note-card__title", { text: n.title || "Untitled note" }));
    if (n.body) c.append(el("div.note-card__body", { text: n.body }));
    const meta = el("div.note-card__meta");
    if (proj) meta.append(el("span.chip.chip--proj", { text: "◇ " + proj.title }));
    n.tags.forEach((t) => meta.append(el("span.chip.chip--tag", { text: "#" + t })));
    if (meta.children.length) c.append(meta);
    if (src) c.append(el("div.note-card__src", { html: `↳ from task: ${escapeHtml(src.title)}` }));
    return c;
  };

  mount.append(
    head("NOTES", "✎", "Every note — standalone or captured inside a task — filed by <b>tag</b> and <b>project</b>. Task-context notes inherit their task's project automatically.", [addBtn]),
    tags.length ? tagBar : "",
    el("div", { style: "margin-top:-8px" }, [projBar]),
    items.length ? el("div.grid.grid--cards", {}, items.map(card))
      : empty("✎", "No notes here", "Create one, or add a note inside any task and it lands here"),
  );
}

/* ===================== REVIEW ===================== */
export function review(mount) {
  const c = store.counts();
  const staleInbox = c.inbox > 0;
  const noNext = store.projects.filter((p) => p.status === "active" && !store.projectTasks(p).some((t) => t.status === "next"));
  const steps = [
    ["⬇", "Empty your inbox", `${c.inbox} item(s) waiting to be clarified`, staleInbox],
    ["→", "Review next actions", `${c.next} action(s) — are they still the true next step?`, false],
    ["◇", "Review projects", noNext.length ? `${noNext.length} project(s) have NO next action — stalled!` : "Every active project has a next action ✓", noNext.length > 0],
    ["⧖", "Review waiting-for", `${c.waiting} item(s) — nudge anyone?`, false],
    ["✶", "Review someday/maybe", `${c.someday} item(s) — anything ready to activate?`, false],
  ];
  mount.append(
    head("WEEKLY REVIEW", "↻", "The keystone habit. Run this loop to get clear, current, and creative. Trust the system again."),
    el("div.panel", {}, [el("div.panel__body", {}, steps.map(([icon, title, sub, alert]) =>
      el("div.task", {}, [
        el("div.task__check", { html: alert ? "!" : "✓", style: alert ? "border-color:var(--amber);color:var(--amber)" : "border-color:var(--lime);color:var(--lime)" }),
        el("div.task__main", {}, [
          el("div.task__title", { text: icon + "  " + title, style: "cursor:default" }),
          el("div.task__meta", {}, [el("span", { class: "view-sub", style: "margin:0", text: sub })]),
        ]),
      ])
    ))]),
    noNext.length ? el("div", { style: "margin-top:20px" }, [
      panel("⚠ Stalled projects — add a next action", noNext.length, "var(--amber)",
        noNext.map((p) => el("div.task", { onClick: () => openProject(p.id), style: "cursor:pointer" }, [
          el("div.task__main", {}, [el("div.task__title", { text: "◇ " + p.title })]),
        ])))
    ]) : "",
  );
}

/* ---------- filter chip + rerender ---------- */
function filterChip(label, on, onClick, color) {
  const chip = el("button", { class: "chip is-btn" + (on ? " is-on" : ""), text: label, onClick });
  if (color) chip.style.color = color;
  return chip;
}
function rerender(mount, fn) { clear(mount); fn(mount); }
