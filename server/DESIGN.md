# NULLPOINT sync architecture (hardened)

Local-first, optimistic UI, durable background sync to local Postgres. The network is
never in the interaction path. Distilled from a 6-lens adversarial design review.

## Keystone: diff-in-`_emit` op capture
Mutations cascade across sibling rows (deleteTask nulls note.taskId; deleteProject
detaches projectId on tasks+notes; addNote/updateNote/deleteNote rewrite noteIds). So we
do NOT record ops by wrapping mutators. Instead `_emit()` diffs `state` against a shadow
copy (ignoring `rev`/`updatedAt`) and emits a **full-row upsert** for every entity whose
meaningful fields changed, plus a **tombstone upsert** (deleted_at set, from shadow data)
for every id that vanished. This automatically covers cascades, import/reset/loadDemo
(wholesale replace → correct upserts+tombstones), and makes coalescing safe (snapshots,
not patches).

## Versioning / LWW
Every entity carries `rev` (int, bumped per change in `_emit`) and `updatedAt` (client ISO,
also stamped in `_emit` so cascade siblings advance). Server LWW predicate, used identically
for apply-on-push and merge-on-pull:
  apply iff  op.rev > row.rev  OR  (op.rev == row.rev AND op.updatedAt > row.updatedAt)
ISO-8601 is lexically sortable so `updatedAt` is compared as TEXT (never timestamptz —
that would diverge from the client's String comparison). A delete is just an upsert with
`deleted_at` set, so there is ONE op type and replay is naturally idempotent (the rev guard
makes a re-sent op a no-op). No op-ledger table needed.

## Durability / exactly-once-effect
- Queue lives in its own localStorage key (separate from the state cache so cache corruption
  can't take unsynced ops down). Coalesced in memory by `entity:id` (latest rev wins).
- Flush: move the coalesced batch to an `inflight` key, POST, clear inflight only on a 2xx
  whose body lists acked opIds. On reload, replay inflight BEFORE queue. Lost-ack → replay →
  rev-guard no-op. Nothing acknowledged is ever lost.

## Syncer state machine (fetch outcome is the only truth, not navigator.onLine)
IDLE · DIRTY(debounce) · PUSHING · BACKOFF · PULLING · AUTH_WAIT.
- Debounce 350ms trailing, maxWait 1500ms. Immediate flush on `pagehide`/visibility-hidden.
- Push/pull MUTEX: never pull while ops are queued or a push is in flight. Order is always
  flush-then-pull. A pulled row is skipped if a pending op exists for that id (local wins
  until acked).
- Errors classified: network/AbortTimeout/5xx → BACKOFF (exp backoff, full jitter, cap 60s,
  honor Retry-After); 401/403 → AUTH_WAIT (keep queue, re-prompt, never spin); 400/422 →
  quarantine the offending opIds (dead-letter), keep draining the rest.
- Wake triggers: `online`, `focus`, `visibilitychange→visible` → one deduped maybeFlush.

## Merge must not jank
Hydration/pull merge defers if `document.activeElement` is INPUT/TEXTAREA/SELECT or a drawer
is open; it re-attempts on blur/drawer-close. It applies via the existing `refreshView()`
(preserves scrollTop) — never re-opens a drawer, never steals caret. No-op pulls touch no DOM.
Applying remote rows bypasses op-capture and syncs the shadow so merged rows don't echo back.

## Pull cursor
Server assigns monotonic `seq` (global sequence) on every applied write. `GET /api/state`
returns the full non-deleted snapshot + max seq (first load). `GET /api/changes?since=seq`
returns rows incl tombstones with seq>since (subsequent pulls) — gap-tolerant, never
re-pulls everything.

## Schema (text LWW clock, derived edges)
- `updated_at TEXT`, `rev INT`, `seq BIGINT`, `deleted_at TEXT NULL`, `created_at TEXT`.
- `due/completed_at` nullable, NO default. `waiting_for TEXT NOT NULL DEFAULT ''`.
- `sort_order DOUBLE PRECISION` nullable — manual drag order. Null falls back to
  -createdAt client-side, so it's only set once a task is dragged (no backfill). A
  drop changes only the moved task (midpoint of its neighbors), so reordering a
  filtered/overlapping list never disturbs hidden tasks.
- `contexts/tags` jsonb. **noteIds are NOT stored** — derived on read via jsonb_agg from
  notes.task_id / notes.project_id (the back-refs are the single source of truth, so the
  redundant arrays self-heal instead of drifting).
- **No DB foreign keys.** project_id / task_id are advisory text — the client tolerates
  dangling ids, and a hard FK would wedge a batch carrying a cross-device reference to a
  not-yet-synced row. Integrity is app-managed and self-heals via the derived noteIds.
- Schema is created with `CREATE TABLE/INDEX IF NOT EXISTS` on boot (greenfield-safe,
  idempotent). Evolving a populated DB requires an explicit `ALTER TABLE ... ADD COLUMN
  IF NOT EXISTS` in `migrate()` — a plain `CREATE` is a no-op against an existing table.

## Security (public URL!)
- `.env` gitignored (was NOT — fixed). Secret read server-side only via `Bun.env.SYNC_SECRET`;
  fail-fast if unset; never in the static-served root.
- Static root = dedicated `public/` (NOT repo root — keeps .git/.env/server unreachable).
  `/api/*` matched before static; no directory listing; reject `..`.
- Auth: bearer header. Timing-safe compare = SHA-256 both sides → `timingSafeEqual`. Reject
  missing/oversized headers. Per-IP (CF-Connecting-IP) + global failure rate-limit w/ lockout.
- CORS deny-by-default, no Origin reflection, header-only token (no cookie → no CSRF). CSP.
- Entity→table is a hardcoded allowlist; every value parameterized via Bun.sql tags (tags only
  protect VALUES, never identifiers). Max body 1MB, batch cap, op-shape validation. Generic
  errors (no leakage).
- Unlock gate: no token → unlock screen only. Token present (prior auth on this device) →
  render cache instantly (snappy) + validate in background; 401 → lock (wipe in-memory, re-prompt).
  Explicit Lock action for shared devices. (Tradeoff: localStorage cache is plaintext on-device.)
- XSS: stored strings rendered via textContent, not `html:` (now that a 2nd device can write).

## Consciously simplified (single-user scope) — documented, not forgotten
- Multi-tab: rely on server idempotency (concurrent identical pushes are no-ops) rather than
  Web-Locks leader election.
- Queue in localStorage (tiny data) rather than IndexedDB; separate key + integrity guard.
- jsonb array fields are whole-value LWW (concurrent appends from 2 devices → one wins).
