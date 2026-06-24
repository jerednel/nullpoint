/* ============================================================
   NULLPOINT // SYNC
   Optimistic local-first background sync. The UI never awaits anything here.

   Queue holds all UNACKED ops (coalesced by entity:id, full snapshots). Ops stay
   in the queue until the server acks them, so a lost ack just means a harmless
   replay (the server's rev guard makes re-applying a no-op → exactly-once-effect).

   State machine, fetch-outcome is the only truth (never navigator.onLine):
     idle · dirty(debounce) · pushing · backoff · pulling · authwait
   Push and pull are mutually exclusive; a pull never runs while ops are queued.
   ============================================================ */
import { store } from "./store.js?v=pg1";
import { isDragging } from "./sortable.js?v=pg1";

const API = "/api";
const K = { token: "nullpoint.sync.token", queue: "nullpoint.sync.queue.v1", cursor: "nullpoint.sync.cursor", adopted: "nullpoint.sync.adopted" };
const DEBOUNCE = 350, MAX_WAIT = 1500, BACKOFF_BASE = 1000, BACKOFF_MAX = 60000, TIMEOUT = 8000, POLL = 30000;
const opId = () => "op_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

let token = localStorage.getItem(K.token) || null;
let cursor = localStorage.getItem(K.cursor) || "0";
let queue = loadQueue();           // Map "entity:id" -> op{opId,entity,id,rev,updatedAt,deletedAt,data}
let phase = "idle";
let booting = false;               // true for the whole of bootstrap() — blocks concurrent pulls/flushes
let attempt = 0;
let flushTimer = null, maxWaitTimer = null, backoffTimer = null, persistTimer = null;
let pendingMerge = null;           // remote changes deferred while the user is typing
let statusCb = () => {}, authCb = () => {};

/* ---------------- queue persistence (own key, separate from state cache) ----- */
function loadQueue() {
  try {
    const arr = JSON.parse(localStorage.getItem(K.queue) || "[]");
    const m = new Map();
    for (const op of arr) m.set(op.entity + ":" + op.id, op);
    return m;
  } catch { return new Map(); }
}
function persistQueue() {
  try { localStorage.setItem(K.queue, JSON.stringify([...queue.values()])); } catch (e) { console.warn("queue persist failed", e); }
}
function persistQueueThrottled() { if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; persistQueue(); }, 250); }
function mergeQueueFromStorage() {            // best-effort cross-tab reconcile (rev-guarded)
  try {
    for (const op of JSON.parse(localStorage.getItem(K.queue) || "[]")) {
      const k = op.entity + ":" + op.id, cur = queue.get(k);
      if (!cur || (op.rev || 0) > (cur.rev || 0)) queue.set(k, op);
    }
  } catch {}
}

/* ---------------- status ---------------- */
function setPhase(p) { phase = p; emit(); }
function emit() { statusCb({ phase, queued: queue.size, online: navigator.onLine }); }

/* ---------------- the op sink (store calls this on every change) ------------- */
function enqueue(ops) {
  mergeQueueFromStorage();
  for (const op of ops) queue.set(op.entity + ":" + op.id, { ...op, opId: opId() });
  persistQueueThrottled();
  if (phase === "authwait") { emit(); return; }     // keep queuing while locked, don't push
  arm();
}
function arm() {
  if (booting) return;             // bootstrap drives its own flush; don't race it
  if (!queue.size) { setPhase("idle"); return; }
  setPhase(phase === "pushing" || phase === "pulling" ? phase : "dirty");
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, DEBOUNCE);
  if (!maxWaitTimer) maxWaitTimer = setTimeout(flush, MAX_WAIT);
}

/* ---------------- fetch helper ---------------- */
function api(path, opts = {}) {
  return fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/* ---------------- push ---------------- */
async function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  clearTimeout(maxWaitTimer); maxWaitTimer = null;
  if (phase === "pushing" || phase === "pulling" || phase === "authwait" || !token) return;
  mergeQueueFromStorage();
  if (!queue.size) { setPhase("idle"); maybePull(); return; }
  setPhase("pushing");
  const batch = [...queue.values()];
  let res;
  try { res = await api("/sync", { method: "POST", body: JSON.stringify({ ops: batch }) }); }
  catch { return backoff(); }                         // network / timeout
  if (res.status === 401 || res.status === 403) return toAuth();
  if (res.status >= 500) return backoff();
  let body = {}; try { body = await res.json(); } catch {}
  if (!res.ok) return deadLetter(batch, res.status, body.rejected);   // 400/413/422 (precise drop)
  const acked = new Set(body.acked || []);
  for (const op of batch) {
    const k = op.entity + ":" + op.id, cur = queue.get(k);
    if (cur && cur.opId === op.opId && acked.has(op.opId)) queue.delete(k);   // remove only if not superseded since send
  }
  persistQueue();   // (cross-tab adds are picked up by the `storage` listener, never by re-reading
                    //  stale storage here — that would resurrect just-acked ops into an infinite loop)
  attempt = 0;
  if (queue.size) { setPhase("dirty"); flushTimer = setTimeout(flush, 0); }
  else setPhase("idle");            // pulls run on POLL/wake, not after every push (avoids per-edit churn)
}
function backoff() {
  attempt++;
  setPhase("backoff");
  const cap = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (attempt - 1));
  clearTimeout(backoffTimer);
  backoffTimer = setTimeout(() => { backoffTimer = null; flush(); }, Math.random() * cap);   // full jitter
}
function deadLetter(batch, status, rejected) {
  // Drop ONLY the ops the server explicitly rejected, so co-queued valid edits
  // for other entities aren't lost too. If it didn't say which (a structural 4xx
  // our client shouldn't produce), drop the batch to avoid wedging the queue.
  const drop = Array.isArray(rejected) && rejected.length ? new Set(rejected) : new Set(batch.map((o) => o.opId));
  for (const op of batch) { const k = op.entity + ":" + op.id; if (drop.has(op.opId) && queue.get(k)?.opId === op.opId) queue.delete(k); }
  persistQueue(); attempt = 0;
  console.warn("sync: server rejected ops", status, rejected || "(whole batch)");
  statusCb({ phase: "error", queued: queue.size, online: navigator.onLine });
  if (queue.size) arm(); else setPhase("idle");
}
function toAuth() { setPhase("authwait"); authCb(); }

/* ---------------- pull (mutex: never while ops queued / mid-push) ------------ */
async function maybePull() {
  if (booting || isDragging() || phase !== "idle" || queue.size || !token) return;
  setPhase("pulling");
  let res;
  try { res = await api("/changes?since=" + encodeURIComponent(cursor)); }
  catch { setPhase(queue.size ? "dirty" : "idle"); return; }
  if (res.status === 401 || res.status === 403) return toAuth();
  if (!res.ok) { setPhase("idle"); return; }
  const data = await res.json();
  applyMerge(data);
  if (data.seq) { cursor = data.seq; localStorage.setItem(K.cursor, cursor); }
  setPhase(queue.size ? "dirty" : "idle");
  if (queue.size) arm();
}
function typingOrDrawerOpen() {
  if (isDragging()) return true;        // never rebuild #view mid-drag (would orphan the dragged row)
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
  const d = document.getElementById("drawer");
  return !!(d && !d.hidden);
}
// Drop any remote row that has a PENDING local op for the same id — local wins
// until acked (a later pull reconciles it). Without this, a merge deferred behind
// an open drawer can clobber an edit the user made in the meantime.
function dropPending(data) {
  const out = { tasks: [], projects: [], notes: [] };
  for (const k of ["tasks", "projects", "notes"])
    for (const r of (data[k] || [])) if (!queue.has(k + ":" + r.id)) out[k].push(r);
  return out;
}
function landMerge(data) { store.applyRemote(dropPending(data)); }   // LWW; re-renders only if visible state changed
function applyMerge(data) {
  if (typingOrDrawerOpen()) {           // defer so we never yank caret / rebuild under an open drawer
    if (!pendingMerge) pendingMerge = { tasks: [], projects: [], notes: [] };
    for (const k of ["tasks", "projects", "notes"]) pendingMerge[k].push(...(data[k] || []));
    return;
  }
  landMerge(data);
}
function flushPendingMerge() {
  if (pendingMerge && !typingOrDrawerOpen()) { const m = pendingMerge; pendingMerge = null; landMerge(m); }
}

/* ---------------- wake triggers ---------------- */
function wake() {
  flushPendingMerge();
  if (phase === "authwait") return;
  mergeQueueFromStorage();
  if (queue.size) arm(); else maybePull();
}

/* ---------------- bootstrap / reconcile ---------------- */
async function bootstrap() {
  if (!token) { setPhase("authwait"); authCb(); return false; }
  booting = true;                          // block POLL/wake-driven pulls & flushes for the whole reconcile
  try {
    let res;
    try { res = await api("/state"); }
    catch { setPhase(queue.size ? "dirty" : "idle"); return true; }   // offline: run on cache
    if (res.status === 401 || res.status === 403) { token = null; localStorage.removeItem(K.token); setPhase("authwait"); authCb(); return false; }
    if (!res.ok) { setPhase("idle"); return true; }
    const server = await res.json();
    const serverEmpty = !(server.projects.length || server.tasks.length || server.notes.length);

    if (serverEmpty && store.hasData()) {
      // Empty server + local data → (re-)adopt by pushing local UP. The `!adopted`
      // condition is intentionally dropped: an empty server must NEVER replaceAll-
      // wipe a populated client (e.g. after a DB reset / fresh DATABASE_URL).
      for (const op of store.snapshotOps()) queue.set(op.entity + ":" + op.id, { ...op, opId: opId() });
      persistQueue();
      await flush();
      if (!queue.size) { localStorage.setItem(K.adopted, "1"); cursor = server.seq; localStorage.setItem(K.cursor, cursor); }
    } else {
      if (queue.size) await flush();        // push unsynced local first
      if (!queue.size) {                     // adopt server baseline ONLY once local is fully flushed
        store.replaceAll(server);
        cursor = server.seq; localStorage.setItem(K.cursor, cursor);
        localStorage.setItem(K.adopted, "1");
      }
    }
    setPhase(queue.size ? "dirty" : "idle");
    booting = false;                         // reconcile done — pulls/flushes allowed again
    if (queue.size) arm(); else maybePull();
    return true;
  } finally { booting = false; }
}

/* ---------------- public API ---------------- */
export const sync = {
  init({ onStatus, onAuthRequired }) {
    statusCb = onStatus || statusCb;
    authCb = onAuthRequired || authCb;
    store.setSyncSink(enqueue);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wake();
      else persistQueue();
    });
    document.addEventListener("focusout", () => setTimeout(flushPendingMerge, 0));
    document.addEventListener("np:drawer-closed", flushPendingMerge);   // scrim/Esc/✕ close also lands deferred merges
    window.addEventListener("storage", (e) => { if (e.key === K.queue) { mergeQueueFromStorage(); emit(); } });
    window.addEventListener("pagehide", persistQueue);
    setInterval(() => { flushPendingMerge(); if (phase === "idle" && !queue.size) maybePull(); }, POLL);
    return bootstrap();
  },
  hasToken: () => !!token,
  async validate(t) { try { return (await fetch(API + "/auth", { headers: { Authorization: "Bearer " + t }, signal: AbortSignal.timeout(TIMEOUT) })).ok; } catch { return false; } },
  setToken(t) { token = t; localStorage.setItem(K.token, t); },
  unlock(t) {                          // called after the user enters a valid passphrase
    this.setToken(t);
    if (phase === "authwait") { setPhase("idle"); }
    return bootstrap();
  },
  lock() {                             // explicit lock (shared device): drop token + re-prompt
    token = null; localStorage.removeItem(K.token);
    clearTimeout(flushTimer); clearTimeout(backoffTimer);
    setPhase("authwait");
  },
  drawerClosed: flushPendingMerge,     // app.js calls this so deferred merges land on drawer close
  status: () => ({ phase, queued: queue.size, online: navigator.onLine }),
};
