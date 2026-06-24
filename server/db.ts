/* ============================================================
   NULLPOINT // DATA LAYER  (Bun.sql + Postgres)

   - All timestamp-ish fields are stored as TEXT (the client's exact ISO
     strings) so last-write-wins compares lexically, identically to the
     client. No timestamptz normalization, no tz drift.
   - One op type: a full-row UPSERT. A "delete" is an upsert with
     deleted_at set. The rev guard makes replay a no-op (exactly-once-effect).
   - noteIds are NOT stored; they are derived on read from the FK back-refs
     (notes.task_id / notes.project_id), so the redundant edge arrays
     self-heal instead of drifting across devices.
   - project_id / task_id are advisory (no DB foreign keys): the client
     tolerates dangling ids, and hard FKs would wedge a batch that carries a
     cross-device reference to a not-yet-synced row.
   ============================================================ */
import { SQL } from "bun";

const sql = new SQL(Bun.env.DATABASE_URL || "postgres://jeremy@localhost:5432/nullpoint");

/* entity -> table is a HARDCODED allowlist. Bun.sql tagged templates only
   parameterize VALUES, never identifiers, so the table name must never come
   from request data. */
const TABLES = { projects: true, tasks: true, notes: true } as const;
export type Entity = keyof typeof TABLES;
export const isEntity = (e: unknown): e is Entity =>
  typeof e === "string" && Object.prototype.hasOwnProperty.call(TABLES, e);

/* ---------------- migrations (idempotent, run on boot) ----------------
   Greenfield-safe: CREATE ... IF NOT EXISTS is a no-op on an existing DB. To
   ADD a column to a populated DB later, append an explicit
   `alter table X add column if not exists ...` below — a plain CREATE won't. */
export async function migrate() {
  await sql`create sequence if not exists np_seq`;

  await sql`create table if not exists projects (
    id text primary key,
    title text not null default 'New project',
    outcome text not null default '',
    status text not null default 'active',
    created_at text not null,
    updated_at text not null,
    rev int not null default 1,
    seq bigint not null,
    deleted_at text
  )`;

  await sql`create table if not exists tasks (
    id text primary key,
    title text not null default 'Untitled',
    status text not null default 'inbox',
    project_id text,
    contexts jsonb not null default '[]'::jsonb,
    due text,
    waiting_for text not null default '',
    flagged boolean not null default false,
    created_at text not null,
    updated_at text not null,
    completed_at text,
    rev int not null default 1,
    seq bigint not null,
    deleted_at text
  )`;

  await sql`create table if not exists notes (
    id text primary key,
    title text not null default '',
    body text not null default '',
    tags jsonb not null default '[]'::jsonb,
    project_id text,
    task_id text,
    created_at text not null,
    updated_at text not null,
    rev int not null default 1,
    seq bigint not null,
    deleted_at text
  )`;

  // cursor + derivation + snapshot hot paths
  await sql`create index if not exists ix_projects_seq on projects (seq)`;
  await sql`create index if not exists ix_tasks_seq on tasks (seq)`;
  await sql`create index if not exists ix_notes_seq on notes (seq)`;
  await sql`create index if not exists ix_notes_task on notes (task_id) where deleted_at is null`;
  await sql`create index if not exists ix_notes_project on notes (project_id) where deleted_at is null`;
  await sql`create index if not exists ix_projects_live on projects (id) where deleted_at is null`;
  await sql`create index if not exists ix_tasks_live on tasks (id) where deleted_at is null`;
}

/* ---------------- client <-> row mapping (explicit, per entity) ---------------- */
const str = (v: any, d = "") => (v == null ? d : String(v));
const orNull = (v: any) => (v == null || v === "" ? null : String(v));
/* Bun.sql returns jsonb columns as raw JSON text (but jsonb_agg results as
   parsed arrays) — normalize either form to a real JS array. */
const jarr = (v: any): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

function rowToProject(r: any) {
  return {
    id: r.id, title: r.title, outcome: r.outcome, status: r.status,
    noteIds: jarr(r.note_ids),
    createdAt: r.created_at, updatedAt: r.updated_at,
    rev: r.rev, deletedAt: r.deleted_at ?? null,
  };
}
function rowToTask(r: any) {
  return {
    id: r.id, title: r.title, status: r.status, projectId: r.project_id ?? null,
    contexts: jarr(r.contexts), noteIds: jarr(r.note_ids),
    due: r.due ?? null, waitingFor: r.waiting_for ?? "", flagged: !!r.flagged,
    createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at ?? null,
    rev: r.rev, deletedAt: r.deleted_at ?? null,
  };
}
function rowToNote(r: any) {
  return {
    id: r.id, title: r.title, body: r.body, tags: jarr(r.tags),
    projectId: r.project_id ?? null, taskId: r.task_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    rev: r.rev, deletedAt: r.deleted_at ?? null,
  };
}
const ROW_TO_CLIENT = { projects: rowToProject, tasks: rowToTask, notes: rowToNote };

/* ---------------- apply a batch of upserts (one transaction) ----------------
   Every op is a full-row upsert guarded by the LWW predicate. Returns the set
   of opIds the server processed (applied OR safely-skipped-as-stale — both are
   "done" from the client's view, so it clears them) and the new max seq. */
export async function applyOps(ops: any[]): Promise<{ acked: string[]; seq: string }> {
  const acked: string[] = [];
  await sql.begin(async (tx) => {
    for (const op of ops) {
      const d = op.data || {};
      const rev = Number(op.rev) || 1;
      const updatedAt = str(op.updatedAt);
      const deletedAt = orNull(op.deletedAt);
      const createdAt = str(d.createdAt ?? op.createdAt ?? updatedAt);

      if (op.entity === "projects") {
        await tx`insert into projects (id,title,outcome,status,created_at,updated_at,rev,seq,deleted_at)
          values (${d.id}, ${str(d.title, "New project")}, ${str(d.outcome)}, ${str(d.status, "active")},
                  ${createdAt}, ${updatedAt}, ${rev}, nextval('np_seq'), ${deletedAt})
          on conflict (id) do update set
            title=excluded.title, outcome=excluded.outcome, status=excluded.status,
            updated_at=excluded.updated_at, rev=excluded.rev, seq=excluded.seq, deleted_at=excluded.deleted_at
          where excluded.rev > projects.rev
             or (excluded.rev = projects.rev and excluded.updated_at > projects.updated_at)`;
      } else if (op.entity === "tasks") {
        await tx`insert into tasks (id,title,status,project_id,contexts,due,waiting_for,flagged,created_at,updated_at,completed_at,rev,seq,deleted_at)
          values (${d.id}, ${str(d.title, "Untitled")}, ${str(d.status, "inbox")}, ${orNull(d.projectId)},
                  ${JSON.stringify(d.contexts ?? [])}::jsonb, ${orNull(d.due)}, ${str(d.waitingFor)}, ${!!d.flagged},
                  ${createdAt}, ${updatedAt}, ${orNull(d.completedAt)}, ${rev}, nextval('np_seq'), ${deletedAt})
          on conflict (id) do update set
            title=excluded.title, status=excluded.status, project_id=excluded.project_id,
            contexts=excluded.contexts, due=excluded.due, waiting_for=excluded.waiting_for,
            flagged=excluded.flagged, updated_at=excluded.updated_at, completed_at=excluded.completed_at,
            rev=excluded.rev, seq=excluded.seq, deleted_at=excluded.deleted_at
          where excluded.rev > tasks.rev
             or (excluded.rev = tasks.rev and excluded.updated_at > tasks.updated_at)`;
      } else if (op.entity === "notes") {
        await tx`insert into notes (id,title,body,tags,project_id,task_id,created_at,updated_at,rev,seq,deleted_at)
          values (${d.id}, ${str(d.title)}, ${str(d.body)}, ${JSON.stringify(d.tags ?? [])}::jsonb,
                  ${orNull(d.projectId)}, ${orNull(d.taskId)}, ${createdAt}, ${updatedAt}, ${rev}, nextval('np_seq'), ${deletedAt})
          on conflict (id) do update set
            title=excluded.title, body=excluded.body, tags=excluded.tags,
            project_id=excluded.project_id, task_id=excluded.task_id,
            updated_at=excluded.updated_at, rev=excluded.rev, seq=excluded.seq, deleted_at=excluded.deleted_at
          where excluded.rev > notes.rev
             or (excluded.rev = notes.rev and excluded.updated_at > notes.updated_at)`;
      } else {
        continue; // unknown entity already rejected at the route, belt-and-suspenders
      }
      acked.push(op.opId);
    }
  });
  const [{ seq }] = await sql`select coalesce(last_value, 0)::text as seq from np_seq`;
  return { acked, seq };
}

/* ---------------- full snapshot (first load) ---------------- */
export async function getState() {
  const projects = await sql`
    select p.*, coalesce((select jsonb_agg(n.id order by n.created_at)
      from notes n where n.project_id = p.id and n.deleted_at is null), '[]'::jsonb) as note_ids
    from projects p where p.deleted_at is null order by p.created_at desc`;
  const tasks = await sql`
    select t.*, coalesce((select jsonb_agg(n.id order by n.created_at)
      from notes n where n.task_id = t.id and n.deleted_at is null), '[]'::jsonb) as note_ids
    from tasks t where t.deleted_at is null order by t.created_at desc`;
  const notes = await sql`select * from notes where deleted_at is null order by created_at desc`;
  const [{ seq }] = await sql`select coalesce(last_value, 0)::text as seq from np_seq`;
  return {
    projects: projects.map(rowToProject),
    tasks: tasks.map(rowToTask),
    notes: notes.map(rowToNote),
    seq,
  };
}

/* ---------------- incremental changes (subsequent pulls) ----------------
   Returns rows (INCLUDING tombstones) with seq > since, so the client learns
   about remote edits and deletes without re-pulling everything. */
export async function getChanges(since: string) {
  const s = since && /^\d+$/.test(since) ? since : "0";
  const projects = await sql`select * from projects where seq > ${s} order by seq`;
  const tasks = await sql`select * from tasks where seq > ${s} order by seq`;
  const notes = await sql`select * from notes where seq > ${s} order by seq`;
  const [{ seq }] = await sql`select coalesce(last_value, 0)::text as seq from np_seq`;
  return {
    projects: projects.map(rowToProject),
    tasks: tasks.map(rowToTask),
    notes: notes.map(rowToNote),
    seq,
  };
}

export { sql, ROW_TO_CLIENT };
