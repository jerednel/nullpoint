/* ============================================================
   NULLPOINT // UNLOCK GATE
   Full-screen overlay shown when there is no valid token. Nothing of the GTD
   board is rendered behind it until the passphrase validates against the server.
   ============================================================ */
import { el } from "./dom.js?v=pg1";
import { sync } from "./sync.js?v=pg1";

let overlay = null;

export function showUnlock(onUnlocked) {
  if (overlay) return;
  const input = el("input.input.unlock__input", {
    type: "password", placeholder: "passphrase", autocomplete: "current-password", "aria-label": "Passphrase",
  });
  const err = el("div.unlock__err", { text: "" });
  const btn = el("button.btn.btn--primary", { type: "submit", text: "UNLOCK" });

  const submit = async (e) => {
    e?.preventDefault();
    const t = input.value;
    if (!t) return;
    btn.disabled = true; btn.textContent = "…"; err.textContent = "";
    const ok = await sync.validate(t);
    btn.disabled = false; btn.textContent = "UNLOCK";
    if (!ok) { err.textContent = "wrong passphrase"; input.select(); return; }
    hideUnlock();
    onUnlocked(t);
  };

  const box = el("form.unlock__box", { onSubmit: submit }, [
    el("div.unlock__brand", {}, [el("span.brand__mark", { text: "◈" }), el("span", { text: "NULLPOINT" })]),
    el("div.unlock__sub", { text: "// locked · enter passphrase" }),
    input,
    err,
    el("div.unlock__row", {}, [btn]),
  ]);
  overlay = el("div.unlock", {}, [box]);
  document.body.append(overlay);
  setTimeout(() => input.focus(), 60);
}

export function hideUnlock() {
  if (overlay) { overlay.remove(); overlay = null; }
}
