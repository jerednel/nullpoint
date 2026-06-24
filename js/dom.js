/* ============================================================
   NULLPOINT // DOM HELPERS
   ============================================================ */

/** Tiny hyperscript: el("div.card", {onClick}, [children]) */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && k !== "list") { try { node[k] = v; } catch { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export const escapeHtml = (s = "") =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* relative-ish date formatting */
export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const that = new Date(d); that.setHours(0,0,0,0);
  const days = Math.round((that - today) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days < 7) return `in ${days}d`;
  if (days < -1 && days > -7) return `${-days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const isOverdue = (iso) => iso && new Date(iso) < new Date(new Date().toDateString());

/* toast */
let toastTimer;
export function toast(msg) {
  const wrap = document.getElementById("toasts");
  const t = el("div.toast", { html: msg });
  wrap.append(t);
  clearTimeout(toastTimer);
  setTimeout(() => { t.style.transition = "opacity .3s, transform .3s"; t.style.opacity = "0"; t.style.transform = "translateY(10px)"; setTimeout(() => t.remove(), 320); }, 2600);
}

/* parse "@context" tokens and "#tag" out of free text */
export function parseCapture(raw) {
  const contexts = [];
  let title = raw.replace(/(^|\s)(@[\w-]+)/g, (_, sp, ctx) => { contexts.push(ctx.toLowerCase()); return sp; });
  let flagged = false;
  if (/(^|\s)!(\s|$)/.test(title) || /\s!$/.test(title)) { flagged = true; title = title.replace(/(^|\s)!(?=\s|$)/g, " "); }
  return { title: title.replace(/\s+/g, " ").trim() || raw.trim(), contexts, flagged };
}
