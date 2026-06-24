/* ============================================================
   NULLPOINT // SORTABLE
   Pointer-based vertical drag-reorder for a list of `.task` rows that each
   carry a `.drag-handle` and `data-id`. Works with mouse AND touch (pointer
   events + setPointerCapture; touch-action:none on the handle stops scroll).
   Calls onDrop(id, beforeId, afterId) with the dropped row's new neighbors.
   ============================================================ */

let _dragging = false;
export const isDragging = () => _dragging;   // sync uses this to pause merges/pulls mid-drag

function rowsExcept(container, dragging) {
  return [...container.children].filter((c) => c.classList?.contains("task") && c !== dragging);
}

// the row the dragged item should be inserted BEFORE for the given pointer Y
function insertBeforeFor(container, dragging, y) {
  let best = null, bestOffset = -Infinity;
  for (const child of rowsExcept(container, dragging)) {
    const box = child.getBoundingClientRect();
    const offset = y - (box.top + box.height / 2);
    if (offset < 0 && offset > bestOffset) { bestOffset = offset; best = child; }
  }
  return best; // null → append at end
}

export function sortableList(container, onDrop) {
  container.querySelectorAll(":scope > .task > .drag-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      if ((e.button != null && e.button !== 0) || e.isPrimary === false || _dragging) return;  // primary pointer only, one at a time
      const row = handle.closest(".task");
      if (!row) return;
      e.preventDefault();
      let moved = false, done = false;
      _dragging = true;
      row.classList.add("is-dragging");
      try { handle.setPointerCapture(e.pointerId); } catch {}

      const onMove = (ev) => {
        moved = true;
        const ref = insertBeforeFor(container, row, ev.clientY);
        if (ref == null) { if (row.nextElementSibling) container.appendChild(row); }
        else if (ref !== row.nextElementSibling) container.insertBefore(row, ref);
      };
      const onUp = () => {
        if (done) return;       // any of pointerup/cancel/lostpointercapture lands here exactly once
        done = true; _dragging = false;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        handle.removeEventListener("lostpointercapture", onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        row.classList.remove("is-dragging");
        if (moved) {
          const before = row.previousElementSibling?.dataset?.id || null;
          const after = row.nextElementSibling?.dataset?.id || null;
          onDrop(row.dataset.id, before, after);
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
      handle.addEventListener("lostpointercapture", onUp);   // re-render mid-drag / capture loss → still clean up
    });
  });
}
