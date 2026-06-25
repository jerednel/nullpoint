/* ============================================================
   NULLPOINT // WEEKLY REVIEW TOUR
   A guided walkthrough that drives the app through each GTD review pane with a
   persistent bar (step, guidance, live count, back/next). The real view renders
   behind it so you actually work each step.
   ============================================================ */
import { store } from "./store.js?v=pg1";
import { el, clear } from "./dom.js?v=pg1";

const STEPS = [
  { hash: "inbox", icon: "⬇", title: "Empty your inbox", guide: "Clarify every item — turn each into a next action, project, someday, or reference note. Aim for inbox zero.", status: (c) => (c.inbox ? `${c.inbox} left to clarify` : "inbox zero ✓") },
  { hash: "next", icon: "→", title: "Review next actions", guide: "Is each still the true next physical step? Tick off what's done, drag to re-prioritize, fix contexts.", status: (c) => `${c.next} next action(s)` },
  { hash: "projects", icon: "◇", title: "Review projects", guide: "Every active project needs at least one next action. Open any stalled one and add the next step.", status: (c, x) => (x.stalled ? `⚠ ${x.stalled} project(s) with NO next action` : "every project has a next action ✓") },
  { hash: "waiting", icon: "⧖", title: "Review waiting-for", guide: "Anyone to nudge? Anything that landed and is now ready to move forward?", status: (c) => `${c.waiting} item(s) waiting` },
  { hash: "someday", icon: "✶", title: "Review someday / maybe", guide: "Anything ready to pull into action? Anything to let go of?", status: (c) => `${c.someday} item(s) incubating` },
];

let idx = -1, bar = null;

export function startReview() { go(0); }

function exit() { idx = -1; if (bar) { bar.remove(); bar = null; } }

function go(n) {
  idx = Math.max(0, Math.min(STEPS.length - 1, n));
  if (location.hash.replace(/^#\/?/, "") !== STEPS[idx].hash) location.hash = "/" + STEPS[idx].hash;
  render();
}

function render() {
  if (idx < 0) return;
  const step = STEPS[idx], c = store.counts();
  const x = { stalled: store.projects.filter((p) => p.status === "active" && !store.projectTasks(p.id).some((t) => t.status === "next")).length };
  if (!bar) { bar = el("div.reviewbar"); document.body.append(bar); }
  clear(bar);
  bar.append(
    el("button.reviewbar__close", { html: "✕", title: "Exit review", onClick: exit }),
    el("div.reviewbar__body", {}, [
      el("div.reviewbar__dots", {}, STEPS.map((_, i) => el("span", { class: "reviewbar__dot" + (i === idx ? " is-on" : i < idx ? " is-done" : "") }))),
      el("div.reviewbar__title", {}, [el("span.reviewbar__icon", { text: step.icon }), el("span", { text: `${idx + 1}/${STEPS.length}  ${step.title}` })]),
      el("div.reviewbar__guide", { text: step.guide }),
      el("div.reviewbar__status", { text: step.status(c, x) }),
    ]),
    el("div.reviewbar__nav", {}, [
      el("button.btn.btn--ghost.btn--sm", { text: "‹ back", disabled: idx === 0, onClick: () => go(idx - 1) }),
      idx < STEPS.length - 1
        ? el("button.btn.btn--primary.btn--sm", { text: "next ›", onClick: () => go(idx + 1) })
        : el("button.btn.btn--primary.btn--sm", { html: "✓ finish", onClick: exit }),
    ]),
  );
}

// keep the bar's count live as you work each step
store.subscribe(() => { if (idx >= 0) render(); });
// if you navigate panes manually mid-review, sync the bar to where you landed
window.addEventListener("hashchange", () => {
  if (idx < 0) return;
  const i = STEPS.findIndex((s) => s.hash === location.hash.replace(/^#\/?/, ""));
  if (i >= 0 && i !== idx) { idx = i; render(); }
});
