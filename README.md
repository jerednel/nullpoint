<div align="center">

# ◈ NULLPOINT

**A cyberpunk Getting-Things-Done system.**
Capture everything. Clarify ruthlessly. Engage.

`get_things_done.exe` — dark, glitchy, and legible.

</div>

---

## What it is

NULLPOINT is a complete, single-page [GTD](https://gettingthingsdone.com/) app
with a neon-noir interface. No build step, no backend, no tracking — your data
lives in your own browser (`localStorage`) and never leaves it.

It implements the full GTD workflow:

| Step | In NULLPOINT |
|------|--------------|
| **Capture** | One always-on capture bar (`> _`). Press <kbd>C</kbd> anywhere. |
| **Clarify** | Inbox items get inline buttons: → next action, → waiting, → someday, → project, or → reference note. |
| **Organize** | Next Actions (by context), Projects (outcome + progress), Waiting For, Someday/Maybe. |
| **Reflect** | A built-in Weekly Review that flags stalled projects (no next action) and a stale inbox. |
| **Engage** | Filter next actions by `@context` to match your situation, then work the list. |

## Notes that live in two places at once

Every task has a **task context** — open any task and write notes inside it
(thinking, links, sub-details). Those notes are *also* filed in the dedicated
**Notes** section, automatically:

- categorized by **`#tags`** (typed, or detected inline from the body), and
- by **project** — a task-context note inherits its task's project, so it lands
  in the right bucket without extra work.

You can also create standalone reference notes and tag/file them yourself.

## Design system

Cyberpunk, but **legibility first** — neon is an accent, never the body copy.

- **Canvas:** near-black layered surfaces, hard 1px hairlines, angular `clip-path` edges (no soft cards).
- **Accents:** cyan / magenta / violet / lime / amber neon, used sparingly for state.
- **Motion:** view transitions enter with a blur + chromatic offset; glitch text on the wordmark.
- **Ambience:** CRT scanlines, film grain, a perspective grid glow, and a vignette.
- **Type:** `Chakra Petch` (display/UI), `Share Tech Mono` (meta), `Inter` (reading).
- Respects `prefers-reduced-motion` — all FX calm down for accessibility.

## Keyboard

| Key | Action |
|-----|--------|
| <kbd>C</kbd> | Focus the capture bar |
| <kbd>1</kbd>–<kbd>9</kbd> | Jump between sections |
| <kbd>Esc</kbd> | Close drawer / blur capture |
| `@word` in capture | adds a context (and routes straight to Next Actions) |
| `!` in capture | flags the item |

## Run it

It's static. Open `index.html` via any web server:

```bash
python3 -m http.server
# then visit http://localhost:8000
```

(ES modules require `http://`, not `file://`.) Deploys as-is to GitHub Pages.

Your data: **⇩ export** writes a JSON backup; **⇧ import** restores one.

---

<div align="center"><sub>Built as a personal GTD command center. No accounts, no servers, no surveillance.</sub></div>
