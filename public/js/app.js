/* ============================================================
   NULLPOINT // APP BOOTSTRAP
   Router, nav, global capture, keyboard, IO.
   ============================================================ */
import { store } from "./store.js";
import { el, clear, toast, parseCapture } from "./dom.js";
import { closeDrawer } from "./drawer.js";
import * as views from "./views.js";
import { sync } from "./sync.js";
import { showUnlock } from "./auth.js";

/* ---- route table ---- */
const ROUTES = [
  { id: "dashboard", label: "Dashboard", icon: "▚", render: views.dashboard },
  { sep: "capture" },
  { id: "inbox", label: "Inbox", icon: "⬇", render: views.inbox, count: (c) => c.inbox },
  { sep: "organize" },
  { id: "next", label: "Next Actions", icon: "→", render: views.nextActions, count: (c) => c.next },
  { id: "projects", label: "Projects", icon: "◇", render: views.projects, count: (c) => c.projects },
  { id: "waiting", label: "Waiting For", icon: "⧖", render: views.waiting, count: (c) => c.waiting },
  { id: "someday", label: "Someday", icon: "✶", render: views.someday, count: (c) => c.someday },
  { sep: "reference" },
  { id: "notes", label: "Notes", icon: "✎", render: views.notes, count: (c) => c.notes },
  { id: "review", label: "Weekly Review", icon: "↻", render: views.review },
];
const routeMap = Object.fromEntries(ROUTES.filter((r) => r.id).map((r) => [r.id, r]));

const viewMount = document.getElementById("view");
const navMount = document.getElementById("nav");

function currentRoute() {
  const id = location.hash.replace(/^#\/?/, "") || "dashboard";
  return routeMap[id] ? id : "dashboard";
}

function paint(animate) {
  const id = currentRoute();
  clear(viewMount);
  const wrap = el(animate ? "div.motion-in" : "div");
  viewMount.append(wrap);
  routeMap[id].render(wrap);
  renderNav();
}

/* full navigation: animate + close any open drawer + scroll to top */
function renderView() {
  closeDrawer();
  sync.drawerClosed();          // let any merge deferred behind the drawer land now
  paint(true);
  viewMount.scrollTop = 0;
}

/* lightweight refresh on data change: keep drawer + scroll position */
function refreshView() {
  const top = viewMount.scrollTop;
  paint(false);
  viewMount.scrollTop = top;
}

function renderNav() {
  const active = currentRoute();
  const c = store.counts();
  clear(navMount);
  for (const r of ROUTES) {
    if (r.sep) { navMount.append(el("div.nav__sep", { text: "// " + r.sep })); continue; }
    const count = r.count ? r.count(c) : null;
    const item = el("button", {
      class: "nav__item" + (r.id === active ? " is-active" : ""),
      onClick: () => { location.hash = "/" + r.id; },
    }, [
      el("span.nav__icon", { text: r.icon }),
      el("span", { text: r.label }),
      count != null ? el("span", { class: "nav__count" + (count === 0 ? " is-zero" : ""), text: String(count) }) : "",
    ]);
    navMount.append(item);
  }
}

/* ---- capture ---- */
const captureForm = document.getElementById("capture-form");
const captureInput = document.getElementById("capture-input");
captureForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = captureInput.value.trim();
  if (!raw) return;
  const { title, contexts, flagged } = parseCapture(raw);
  // captured items land in inbox by default (true GTD), but @context implies it's already an actionable next action
  const status = contexts.length ? "next" : "inbox";
  store.addTask({ title, contexts, flagged, status });
  captureInput.value = "";
  toast(status === "next" ? "Captured → Next Actions" : "Captured → Inbox");
});

/* ---- keyboard ---- */
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === "c" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); captureInput.focus(); }
  if (e.key === "Escape" && document.activeElement === captureInput) captureInput.blur();
  // number quick-nav 1-9
  if (!typing && /^[1-9]$/.test(e.key)) {
    const ids = ROUTES.filter((r) => r.id).map((r) => r.id);
    const target = ids[Number(e.key) - 1];
    if (target) location.hash = "/" + target;
  }
});

/* ---- IO ---- */
document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([store.export()], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `nullpoint-gtd-${new Date().toISOString().slice(0,10)}.json` });
  a.click(); URL.revokeObjectURL(a.href);
  toast("Exported backup");
});
const importFile = document.getElementById("import-file");
document.getElementById("import-btn").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const f = importFile.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { store.import(reader.result); toast("Data imported"); location.hash = "/dashboard"; }
    catch { toast("<b style='color:var(--red)'>Import failed</b> — invalid file"); }
    importFile.value = "";
  };
  reader.readAsText(f);
});

/* ---- clock + sys readout ---- */
const clock = document.getElementById("clock");
function tick() {
  const d = new Date();
  clock.textContent = d.toLocaleTimeString(undefined, { hour12: false });
}
tick(); setInterval(tick, 1000);

/* ---- sync status readout (replaces the old hardcoded "online") ---- */
let syncPhase = "idle", syncQueued = 0;
const SYNC_LABEL = {
  idle:    "<b>synced</b>",
  pulling: "<b>synced</b>",
  dirty:   "saving…",
  pushing: "saving…",
  backoff: () => `<b style="color:var(--amber)">offline</b> · ${syncQueued} queued`,
  authwait:"<b style=\"color:var(--red)\">locked</b>",
  error:   "<b style=\"color:var(--red)\">sync error</b>",
};
let lastReadout = "";
function sysReadout() {
  const v = SYNC_LABEL[syncPhase] || "<b>synced</b>";
  const html = `sync: ${typeof v === "function" ? v() : v} · ${store.tasks.length} tasks · ${store.notes.length} notes`;
  if (html === lastReadout) return;          // skip identical rewrites (idle/pulling render the same)
  lastReadout = html;
  document.getElementById("sys-readout").innerHTML = html;
}
function onSyncStatus(s) { syncPhase = s.phase; syncQueued = s.queued; sysReadout(); }

/* ---- auth gate ---- */
const appEl = document.getElementById("app");
function lockUI() {
  appEl.style.visibility = "hidden";
  clear(viewMount); clear(navMount);              // don't leave board data in the DOM while locked
  showUnlock(async (token) => {
    appEl.style.visibility = "";
    await sync.unlock(token);
    renderView(); sysReadout();
  });
}

/* ---- wire it up ---- */
store.subscribe(() => { refreshView(); sysReadout(); });
window.addEventListener("hashchange", renderView);
if (sync.hasToken()) { renderView(); sysReadout(); }   // trusted device → show cached board instantly
else appEl.style.visibility = "hidden";
sync.init({ onStatus: onSyncStatus, onAuthRequired: lockUI });

document.getElementById("lock-btn").addEventListener("click", () => { sync.lock(); lockUI(); });

// mobile menu toggle (injected; only visible < 860px via CSS)
const toggle = el("button.menu-toggle", { html: "☰", onClick: () => document.querySelector(".sidebar").classList.toggle("is-open") });
document.querySelector(".topbar").prepend(toggle);
document.querySelector(".sidebar").addEventListener("click", (e) => { if (e.target.closest(".nav__item")) document.querySelector(".sidebar").classList.remove("is-open"); });
// tap the backdrop (or anywhere outside the panel) to close the mobile nav drawer
document.addEventListener("click", (e) => {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar.classList.contains("is-open")) return;
  if (e.target.closest(".menu-toggle")) return;        // the toggle manages itself
  if (e.target === sidebar || !sidebar.contains(e.target)) sidebar.classList.remove("is-open");
});

console.log("%c◈ NULLPOINT online", "color:#00f0ff;font-family:monospace;font-size:14px");
