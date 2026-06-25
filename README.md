<div align="center">

# ◈ NULLPOINT

**A cyberpunk Getting-Things-Done system.**
Capture everything. Clarify ruthlessly. Engage.

`get_things_done.exe` — dark, glitchy, and legible.

</div>

---

## What it is

NULLPOINT is a complete, single-page [GTD](https://gettingthingsdone.com/) app
with a neon-noir interface. The UI is dependency-free vanilla JS; persistence is
**optimistic local-first** — every action applies instantly in the browser and
syncs to a local **Postgres** database in the background, so the network is never
in your way and the app keeps working offline.

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

## Sync & storage

One [Bun](https://bun.sh) server (`server/`) serves the static app **and** a small
sync API on the same origin, backed by local Postgres.

- **Optimistic, local-first.** Mutations apply to in-memory state and re-render
  instantly; `localStorage` is an offline cache. A durable, debounced, batched
  queue flushes to the server in the background — the UI never awaits the network.
- **No data loss.** Ops are full-row snapshots captured by diffing state, carry a
  per-row `rev`, and are applied idempotently with last-write-wins; a lost ack is a
  harmless replay. Unsynced changes survive reloads and offline stretches.
- **Locked.** The app is gated by a passphrase (bearer token); the API is
  timing-safe-authenticated, rate-limited, and same-origin only. **⊘ lock** clears
  the session on shared devices.
- **⇩ export / ⇧ import** still write and restore JSON backups.

## Run it

Needs [Bun](https://bun.sh) and a local Postgres.

```bash
createdb nullpoint
bun install
cp .env.example .env          # then set SYNC_SECRET to your passphrase
bun start                     # serves app + API on http://localhost:8000
```

Keep it running across reboots with the included LaunchAgent:

```bash
cp server/com.nullpoint.server.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.nullpoint.server.plist
```

Schema is created/migrated automatically on boot. See [`server/DESIGN.md`](server/DESIGN.md)
for the sync architecture.

## Agent access (MCP)

An [MCP](https://modelcontextprotocol.io) server (`server/mcp.ts`, stdio) lets an LLM agent
read and CRUD the board. It writes through the same sync path the web app uses, so agent
changes appear in the UI on its next pull. Register it with your MCP client:

```jsonc
// .mcp.json (Claude Code) or your agent's MCP config
{ "mcpServers": { "nullpoint": {
    "command": "bun", "args": ["/Users/jeremy/git/nullpoint/server/mcp.ts"] } } }
```

15 tools, deliberately scoped so an agent never has to guess which to use: `list_tasks` /
`list_projects` / `list_notes` / `get_project` / `get_summary` for reading, and symmetric
`create_*` / `update_*` / `delete_*` per entity plus `complete_tasks` (batch). Status moves
(including completion) go through `update_task`; deletes are soft/reversible and the
descriptions steer toward status changes over deletion. The tool surface was hardened with an
adversarial agent-usability review (boundaries, descriptions, schemas, coverage, safety).

---

<div align="center"><sub>Built as a personal GTD command center. Your data, your machine, your passphrase.</sub></div>
