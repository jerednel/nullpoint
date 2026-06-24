/* ============================================================
   NULLPOINT // DETAIL DRAWER
   Edit a task (with its in-context notes) or edit a note.
   ============================================================ */
import { store } from "./store.js?v=pg1";
import { el, clear, fmtDate, toast, escapeHtml } from "./dom.js?v=pg1";
import { mdLine } from "./markdown.js?v=pg1";

const scrim = document.getElementById("drawer-scrim");
const drawer = document.getElementById("drawer");

const STATUS = [
  ["inbox", "Inbox"], ["next", "Next action"], ["waiting", "Waiting for"],
  ["someday", "Someday / maybe"], ["done", "Done"],
];

export function closeDrawer() {
  drawer.hidden = true; drawer.setAttribute("aria-hidden", "true");
  scrim.hidden = true; clear(drawer);
  drawer.classList.remove("drawer--center");                    // reset notes' centered-modal mode
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

  const ctxField = contextPicker(id);

  const dueInput = el("input.input", { type: "date", value: task.due ? task.due.slice(0, 10) : "" });
  dueInput.addEventListener("change", () => store.updateTask(id, { due: dueInput.value ? new Date(dueInput.value).toISOString() : null }));
  dueInput.addEventListener("click", () => { try { dueInput.showPicker?.(); } catch {} });   // open the calendar on click

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
      row([field("Due", dueInput), field("Contexts", ctxField)]),
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

/* ---------------- NOTE MODAL (centered, live-markdown) ---------------- */
export function openNote(id) {
  const note = store.note(id);
  if (!note) return;
  clear(drawer);
  drawer.classList.add("drawer--center");

  const titleInput = el("input.notemodal__title", { value: note.title, placeholder: "Untitled note" });
  titleInput.addEventListener("change", () => store.updateNote(id, { title: titleInput.value.trim() }));

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
      el("span", { class: "view-sub", style: "margin:0 0 0 auto", text: "click a line to edit · markdown" }),
      el("button.drawer__close", { html: "✕", onClick: closeDrawer }),
    ]),
    el("div.drawer__body.notemodal", {}, [
      titleInput,
      el("div.mded-wrap", {}, [mdEditor(id)]),
      el("div.notemodal__meta", {}, [field("Project", projSel), field("Tags", tagsInput)]),
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

/* ---------------- contexts: chips + create-or-pick combobox ---------------- */
function contextPicker(taskId) {
  const chips = el("div.tagpick__chips");
  const input = el("input.tagpick__input", { placeholder: "@context…", autocomplete: "off", spellcheck: false });
  const menu = el("div.tagpick__menu", { hidden: true });
  const wrap = el("div.tagpick", {}, [chips, el("div.tagpick__box", {}, [input, menu])]);
  const norm = (c) => (c.startsWith("@") ? c : "@" + c).toLowerCase().replace(/\s+/g, "");
  const selected = () => store.task(taskId)?.contexts || [];

  function commit(next, keepOpen) {
    store.updateTask(taskId, { contexts: [...new Set(next.map(norm).filter((c) => c.length > 1))] });
    drawChips();
    if (keepOpen) { input.value = ""; input.focus(); renderMenu(); }
  }
  function drawChips() {
    clear(chips);
    selected().forEach((c) => chips.append(el("span.tag", {}, [
      el("span", { text: c }),
      el("button.tag__x", { type: "button", html: "×", title: "Remove " + c, onClick: () => commit(selected().filter((x) => x !== c)) }),
    ])));
  }
  function renderMenu() {
    clear(menu);
    const cur = selected(), q = input.value.replace(/^@/, "").toLowerCase().trim();
    store.allContexts().filter((c) => !cur.includes(c) && c.slice(1).includes(q)).slice(0, 8)
      .forEach((c) => menu.append(el("div.tagpick__opt", { text: c, onMouseDown: (e) => { e.preventDefault(); commit([...cur, c], true); } })));
    const fresh = norm(q);
    if (q && !store.allContexts().includes(fresh) && !cur.includes(fresh))
      menu.append(el("div.tagpick__opt.is-new", { html: `+ create <b>${escapeHtml(fresh)}</b>`, onMouseDown: (e) => { e.preventDefault(); commit([...cur, q], true); } }));
    menu.hidden = menu.children.length === 0;
  }
  input.addEventListener("focus", renderMenu);
  input.addEventListener("input", renderMenu);
  input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const v = input.value.trim(); if (v) commit([...selected(), v], true); }
    else if (e.key === "Backspace" && !input.value && selected().length) commit(selected().slice(0, -1), true);
    else if (e.key === "Escape") { if (!menu.hidden) e.stopPropagation(); menu.hidden = true; input.blur(); }
  });
  drawChips();
  return wrap;
}

/* ---------------- live-preview markdown editor ----------------
   Every line renders as markdown until you click into it, then that one line
   becomes raw-editable (Obsidian-style). `switching` suppresses the blur that
   fires when a redraw removes the active textarea, so programmatic moves
   (Enter/Backspace/Arrow/click-another-line) don't fight the blur handler. */
function mdEditor(noteId) {
  const ed = el("div.mded");
  let lines = (store.note(noteId)?.body ?? "").split("\n");
  if (!lines.length) lines = [""];
  let active = -1, caret = null, switching = false, saveT;
  const persist = () => { const b = lines.join("\n"); if (b !== store.note(noteId)?.body) store.updateNote(noteId, { body: b }); };
  const save = () => { clearTimeout(saveT); persist(); };
  const debSave = () => { clearTimeout(saveT); saveT = setTimeout(persist, 600); };
  const grow = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

  function activate(i, pos) { active = i; caret = pos; switching = true; draw(); switching = false; }
  function deactivate() { if (active < 0) return; active = -1; switching = true; draw(); switching = false; save(); }
  function draw() {
    clear(ed);
    lines.forEach((line, i) => {
      if (i === active) {
        const ta = el("textarea.mded__raw", { value: line, rows: 1, spellcheck: false });
        ta.addEventListener("input", () => { lines[i] = ta.value; grow(ta); debSave(); });
        ta.addEventListener("blur", () => { if (switching) return; lines[i] = ta.value; active = -1; save(); draw(); });
        ta.addEventListener("keydown", (e) => key(e, i, ta));
        ed.append(ta);
        requestAnimationFrame(() => { grow(ta); ta.focus(); const p = caret == null ? ta.value.length : caret; try { ta.setSelectionRange(p, p); } catch {} caret = null; });
      } else {
        const div = el("div.mded__line", { html: mdLine(line) });
        div.addEventListener("mousedown", (e) => { e.preventDefault(); activate(i, null); });
        ed.append(div);
      }
    });
  }
  function key(e, i, ta) {
    const at0 = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); const p = ta.selectionStart;
      lines[i] = ta.value.slice(0, p); lines.splice(i + 1, 0, ta.value.slice(p)); save(); activate(i + 1, 0);
    } else if (e.key === "Backspace" && at0 && i > 0) {
      e.preventDefault(); const join = lines[i - 1].length;
      lines[i] = ta.value; lines[i - 1] += lines[i]; lines.splice(i, 1); save(); activate(i - 1, join);
    } else if (e.key === "ArrowUp" && at0 && i > 0) { e.preventDefault(); lines[i] = ta.value; activate(i - 1, null); }
    else if (e.key === "ArrowDown" && atEnd && i < lines.length - 1) { e.preventDefault(); lines[i] = ta.value; activate(i + 1, 0); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); deactivate(); }   // back to preview, don't close the modal
  }
  draw();
  return ed;
}
