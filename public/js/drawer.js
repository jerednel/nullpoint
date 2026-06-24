/* ============================================================
   NULLPOINT // DETAIL DRAWER
   Edit a task (with its in-context notes) or edit a note.
   ============================================================ */
import { store } from "./store.js";
import { el, clear, fmtDate, toast, escapeHtml } from "./dom.js";

const scrim = document.getElementById("drawer-scrim");
const drawer = document.getElementById("drawer");

const STATUS = [
  ["inbox", "Inbox"], ["next", "Next action"], ["waiting", "Waiting for"],
  ["someday", "Someday / maybe"], ["done", "Done"],
];

export function closeDrawer() {
  drawer.hidden = true; drawer.setAttribute("aria-hidden", "true");
  scrim.hidden = true; clear(drawer);
  document.dispatchEvent(new CustomEvent("np:drawer-closed"));   // let sync land any merge deferred behind the drawer
}

/* On in-place refresh (drawer already open — e.g. after a flag toggle or adding
   an action), keep the body scroll position and DON'T steal the caret back to
   the title. Only focus the title on a fresh open. */
function reopenScroll() { return { wasOpen: !drawer.hidden, top: drawer.querySelector(".drawer__body")?.scrollTop || 0 }; }
function restoreFocus(s, titleInput) {
  if (s.wasOpen) { const b = drawer.querySelector(".drawer__body"); if (b) b.scrollTop = s.top; }
  else titleInput.focus();
}
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) closeDrawer(); });

function open() { scrim.hidden = false; drawer.hidden = false; drawer.setAttribute("aria-hidden", "false"); }

function projectOptions(selected) {
  return [el("option", { value: "", text: "— none —", selected: !selected }),
    ...store.projects.map((p) => el("option", { value: p.id, text: p.title, selected: p.id === selected }))];
}

/* ---------------- TASK DRAWER ---------------- */
export function openTask(id) {
  const task = store.task(id);
  if (!task) return;
  const _s = reopenScroll();
  clear(drawer);

  const titleInput = el("textarea.textarea", { value: task.title, rows: 2, style: "min-height:auto;font-family:var(--font-display);font-size:17px" });
  titleInput.addEventListener("change", () => store.updateTask(id, { title: titleInput.value.trim() || "Untitled" }));

  const statusSel = el("select.select", {}, STATUS.map(([v, l]) => el("option", { value: v, text: l, selected: task.status === v })));
  statusSel.addEventListener("change", () => store.updateTask(id, { status: statusSel.value }));

  const projSel = el("select.select", {}, projectOptions(task.projectId));
  projSel.addEventListener("change", () => store.updateTask(id, { projectId: projSel.value || null }));

  const ctxInput = el("input.input", { value: task.contexts.join(" "), placeholder: "@computer @errands" });
  ctxInput.addEventListener("change", () => {
    const ctx = ctxInput.value.split(/\s+/).map((c) => c.trim()).filter(Boolean)
      .map((c) => (c.startsWith("@") ? c : "@" + c).toLowerCase());
    store.updateTask(id, { contexts: [...new Set(ctx)] });
  });

  const dueInput = el("input.input", { type: "date", value: task.due ? task.due.slice(0, 10) : "" });
  dueInput.addEventListener("change", () => store.updateTask(id, { due: dueInput.value ? new Date(dueInput.value).toISOString() : null }));

  const waitingInput = el("input.input", { value: task.waitingFor || "", placeholder: "who / what are you waiting on?" });
  waitingInput.addEventListener("change", () => store.updateTask(id, { waitingFor: waitingInput.value.trim() }));

  const flagBtn = el("button.btn.btn--ghost", { html: task.flagged ? "★ flagged" : "☆ flag", onClick: () => { store.updateTask(id, { flagged: !task.flagged }); openTask(id); } });

  /* in-context notes */
  const notesWrap = el("div");
  const renderNotes = () => {
    clear(notesWrap);
    const notes = store.taskNotes(id);
    if (!notes.length) notesWrap.append(el("div", { class: "view-sub", text: "No notes yet. Capture thinking, links, or sub-details below." }));
    notes.forEach((n) => {
      const card = el("div.subnote");
      const head = el("div.subnote__head", {}, [
        el("span.subnote__title", { text: n.title || "Note" }),
        el("button.subnote__del", { html: "✕", title: "Delete note", onClick: () => { store.deleteNote(n.id); renderNotes(); toast("Note deleted"); } }),
      ]);
      const body = el("div.subnote__body", { text: n.body });
      const meta = el("div.task__meta", {}, n.tags.map((t) => el("span.chip.chip--tag", { text: "#" + t })));
      card.append(head, body, n.tags.length ? meta : "");
      card.style.cursor = "pointer";
      card.title = "Open note";
      card.addEventListener("click", (e) => { if (e.target.closest(".subnote__del")) return; openNote(n.id); });
      notesWrap.append(card);
    });
  };
  renderNotes();

  const noteTitle = el("input.input", { placeholder: "note title (optional)" });
  const noteBody = el("textarea.textarea", { placeholder: "Write a note in this task's context…\n#tags inline are detected." });
  const noteTags = el("input.input", { placeholder: "#tags  (space separated)" });
  const addNoteBtn = el("button.btn.btn--primary", {
    html: "+ add note", onClick: () => {
      if (!noteBody.value.trim() && !noteTitle.value.trim()) { toast("Note is empty"); return; }
      const inlineTags = (noteBody.value.match(/#([\w-]+)/g) || []).map((t) => t.slice(1));
      const tags = [...new Set([...noteTags.value.split(/\s+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean), ...inlineTags])];
      store.addNote({ title: noteTitle.value.trim(), body: noteBody.value.trim(), tags, taskId: id });
      noteTitle.value = ""; noteBody.value = ""; noteTags.value = "";
      renderNotes(); toast("Note filed &amp; linked to project");
    },
  });

  drawer.append(
    el("div.drawer__head", {}, [
      el("span.drawer__kicker", { text: "task" }),
      flagBtn,
      el("button.drawer__close", { html: "✕", onClick: closeDrawer }),
    ]),
    el("div.drawer__body", {}, [
      field("Title", titleInput),
      row([field("Status", statusSel), field("Project", projSel)]),
      row([field("Due", dueInput), field("Contexts", ctxInput)]),
      task.status === "waiting" ? field("Waiting on", waitingInput) : "",
      el("div", { style: "border-top:1px solid var(--line);margin:6px 0 18px" }),
      el("div.field__label", { text: "Notes in this task's context", style: "margin-bottom:10px" }),
      notesWrap,
      el("div", { style: "background:var(--bg-0);border:1px solid var(--line);padding:12px;margin-top:12px" }, [
        noteTitle, el("div", { style: "height:8px" }), noteBody, el("div", { style: "height:8px" }), noteTags,
        el("div", { style: "height:10px" }), addNoteBtn,
      ]),
    ]),
    el("div.drawer__foot", {}, [
      el("span", { class: "view-sub", style: "flex:1", text: "created " + fmtDate(task.createdAt) }),
      el("button.btn.btn--danger", { html: "delete task", onClick: () => { store.deleteTask(id); closeDrawer(); toast("Task deleted"); } }),
    ]),
  );
  open();
  restoreFocus(_s, titleInput);
}

/* ---------------- NOTE DRAWER ---------------- */
export function openNote(id) {
  const note = store.note(id);
  if (!note) return;
  clear(drawer);

  const titleInput = el("input.input", { value: note.title, placeholder: "Note title" });
  titleInput.addEventListener("change", () => store.updateNote(id, { title: titleInput.value.trim() }));

  const bodyInput = el("textarea.textarea", { value: note.body, style: "min-height:220px" });
  bodyInput.addEventListener("change", () => store.updateNote(id, { body: bodyInput.value }));

  const tagsInput = el("input.input", { value: note.tags.join(" "), placeholder: "#design #docs" });
  tagsInput.addEventListener("change", () => {
    const tags = [...new Set(tagsInput.value.split(/\s+/).map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean))];
    store.updateNote(id, { tags });
  });

  const projSel = el("select.select", {}, projectOptions(note.projectId));
  projSel.addEventListener("change", () => store.updateNote(id, { projectId: projSel.value || null }));

  const src = note.taskId ? store.task(note.taskId) : null;

  drawer.append(
    el("div.drawer__head", {}, [
      el("span.drawer__kicker", { text: "note" }),
      el("button.drawer__close", { html: "✕", onClick: closeDrawer }),
    ]),
    el("div.drawer__body", {}, [
      field("Title", titleInput),
      field("Body", bodyInput),
      row([field("Project", projSel), field("Tags", tagsInput)]),
      src ? el("div", { class: "note-card__src", html: `↳ captured in task context: <b style="color:var(--ink-dim)">${escapeHtml(src.title)}</b>` }) : "",
    ]),
    el("div.drawer__foot", {}, [
      el("span", { class: "view-sub", style: "flex:1", text: "updated " + fmtDate(note.updatedAt) }),
      el("button.btn.btn--danger", { html: "delete note", onClick: () => { store.deleteNote(id); closeDrawer(); toast("Note deleted"); } }),
    ]),
  );
  open();
}

/* ---------------- PROJECT DRAWER ---------------- */
export function openProject(id) {
  const p = store.project(id);
  if (!p) return;
  const _s = reopenScroll();
  clear(drawer);

  const titleInput = el("input.input", { value: p.title, placeholder: "Project name", style: "font-family:var(--font-display);font-size:17px" });
  titleInput.addEventListener("change", () => store.updateProject(id, { title: titleInput.value.trim() || "Untitled project" }));

  const outcomeInput = el("textarea.textarea", { value: p.outcome, placeholder: "Define the successful outcome — what does 'done' look like?" });
  outcomeInput.addEventListener("change", () => store.updateProject(id, { outcome: outcomeInput.value.trim() }));

  const statusSel = el("select.select", {}, [["active","Active"],["someday","Someday / maybe"],["done","Done / archived"]].map(([v,l]) => el("option",{value:v,text:l,selected:p.status===v})));
  statusSel.addEventListener("change", () => store.updateProject(id, { status: statusSel.value }));

  const tasks = store.projectTasks(id);
  const taskList = el("div");
  if (!tasks.length) taskList.append(el("div", { class: "view-sub", text: "No actions yet. Add a next action below." }));
  tasks.forEach((t) => {
    taskList.append(el("div.subnote", { style: "border-left-color:var(--cyan);cursor:pointer", onClick: () => openTask(t.id) }, [
      el("div.subnote__head", {}, [
        el("span.subnote__title", { text: t.title }),
        el("span.chip", { text: t.status, style: "margin-left:auto" }),
      ]),
    ]));
  });

  const newAction = el("input.input", { placeholder: "+ add next action…" });
  const addAction = () => {
    if (!newAction.value.trim()) return;
    store.addTask({ title: newAction.value.trim(), status: "next", projectId: id });
    newAction.value = ""; openProject(id);
  };
  newAction.addEventListener("keydown", (e) => { if (e.key === "Enter") addAction(); });

  drawer.append(
    el("div.drawer__head", {}, [
      el("span.drawer__kicker", { text: "project" }),
      el("button.drawer__close", { html: "✕", onClick: closeDrawer }),
    ]),
    el("div.drawer__body", {}, [
      field("Name", titleInput),
      field("Desired outcome", outcomeInput),
      field("Status", statusSel),
      el("div", { style: "border-top:1px solid var(--line);margin:6px 0 16px" }),
      el("div.field__label", { text: `Next actions (${tasks.length})`, style: "margin-bottom:10px" }),
      taskList,
      el("div.row-add", { style: "margin:12px 0 0" }, [newAction, el("button.btn.btn--primary", { html: "add", onClick: addAction })]),
    ]),
    el("div.drawer__foot", {}, [
      el("span", { class: "view-sub", style: "flex:1", text: `${tasks.length} actions` }),
      el("button.btn.btn--danger", { html: "delete project", onClick: () => { store.deleteProject(id); closeDrawer(); toast("Project deleted"); } }),
    ]),
  );
  open();
  restoreFocus(_s, titleInput);
}

/* helpers */
function field(label, control) { return el("div.field", {}, [el("label.field__label", { text: label }), control]); }
function row(fields) { return el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:14px" }, fields); }
