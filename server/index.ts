/* ============================================================
   NULLPOINT // SERVER  (Bun + Hono)
   Serves the static app (public/) AND the sync API (/api/*) on one origin,
   behind the public Cloudflare tunnel. Everything the security review demanded:
   timing-safe bearer auth, IP+global rate-limit/lockout, deny-by-default CORS,
   hardcoded entity allowlist, body-size caps, generic errors, CSP, no dir listing.
   ============================================================ */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { timingSafeEqual } from "node:crypto";
import { migrate, applyOps, getState, getChanges, isEntity } from "./db.ts";

const PORT = Number(Bun.env.PORT || 8000);
const SECRET = Bun.env.SYNC_SECRET;
if (!SECRET || SECRET.length < 8) {
  console.error("FATAL: SYNC_SECRET is unset or too short. Set it in .env and restart.");
  process.exit(1);
}

const enc = new TextEncoder();
async function sha256(s: string): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
const SECRET_DIGEST = await sha256(SECRET);

/* ---------------- rate limiting (in-memory; single process) ---------------- */
const WINDOW = 60_000, PER_IP_MAX = 10, GLOBAL_MAX = 60, LOCKOUT = 60_000;
const ipFails = new Map<string, { n: number; until: number }>();
let globalFails = { n: 0, reset: 0 };
function clientIp(c: any): string {
  return c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || "local";
}
function isLocked(ip: string): boolean {
  const now = Date.now();
  if (globalFails.reset < now) globalFails = { n: 0, reset: now + WINDOW };
  if (globalFails.n >= GLOBAL_MAX) return true;
  const e = ipFails.get(ip);
  return !!(e && e.until > now && e.n >= PER_IP_MAX);
}
function noteFail(ip: string) {
  const now = Date.now();
  if (globalFails.reset < now) globalFails = { n: 0, reset: now + WINDOW };
  globalFails.n++;
  const e = ipFails.get(ip);
  if (!e || e.until < now) ipFails.set(ip, { n: 1, until: now + LOCKOUT });
  else { e.n++; e.until = now + LOCKOUT; }
}

const app = new Hono();

/* security headers on every response (CSP allows Google Fonts + inline style
   attributes the app uses; everything else is same-origin). */
app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});

/* ---------------- auth gate for /api/* (bearer, timing-safe, rate-limited) --- */
app.use("/api/*", async (c, next) => {
  const ip = clientIp(c);
  if (isLocked(ip)) return c.json({ error: "rate_limited" }, 429);

  const h = c.req.header("authorization") || "";
  const presented = h.startsWith("Bearer ") ? h.slice(7) : "";
  // reject missing / absurdly long before hashing
  let ok = false;
  if (presented && presented.length <= 512) {
    ok = timingSafeEqual(await sha256(presented), SECRET_DIGEST);
  }
  if (!ok) { noteFail(ip); return c.json({ error: "unauthorized" }, 401); }
  await next();
});

/* deny cross-origin for the API (bearer header-only model → no CSRF; same-origin
   needs no CORS headers, and we never reflect Origin). */
app.options("/api/*", (c) => c.body(null, 403));

/* ---------------- API ---------------- */
app.get("/api/auth", (c) => c.json({ ok: true })); // unlock-screen validation probe

app.get("/api/state", async (c) => {
  try { return c.json(await getState()); }
  catch (e) { console.error("state error", e); return c.json({ error: "server_error" }, 500); }
});

app.get("/api/changes", async (c) => {
  try { return c.json(await getChanges(c.req.query("since") || "0")); }
  catch (e) { console.error("changes error", e); return c.json({ error: "server_error" }, 500); }
});

const MAX_BODY = 1_000_000, MAX_OPS = 5000, MAX_STR = 100_000;
app.post("/api/sync", async (c) => {
  const len = Number(c.req.header("content-length") || 0);
  if (len > MAX_BODY) return c.json({ error: "payload_too_large" }, 413);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const ops = body?.ops;
  if (!Array.isArray(ops)) return c.json({ error: "bad_request" }, 400);
  if (ops.length > MAX_OPS) return c.json({ error: "too_many_ops" }, 400);

  // validate every op shape server-side; reject the whole batch on a bad op
  // (the client never sends one, so this is purely a hostile-input guard)
  const rejected: string[] = [];
  for (const op of ops) {
    if (!op || typeof op.opId !== "string" || op.opId.length > 80) return c.json({ error: "bad_op" }, 400);
    if (!isEntity(op.entity)) return c.json({ error: "bad_entity" }, 400);
    if (typeof op?.data?.id !== "string" || op.data.id.length > 80) return c.json({ error: "bad_id" }, 400);
    if (op.id != null && op.id !== op.data.id) return c.json({ error: "id_mismatch" }, 400);
    for (const k of ["title", "body", "outcome", "waitingFor"]) {
      if (op.data[k] != null && (typeof op.data[k] !== "string" || op.data[k].length > MAX_STR)) {
        rejected.push(op.opId);
      }
    }
  }
  if (rejected.length) return c.json({ error: "bad_field", rejected }, 400);

  try {
    const { acked, seq } = await applyOps(ops);
    return c.json({ acked, seq });
  } catch (e) {
    console.error("sync error", e);
    return c.json({ error: "server_error" }, 500);
  }
});

/* ---------------- static (public/ only; api already matched above) ---------- */
app.use("/*", serveStatic({
  root: "./public",
  // Serve app assets no-store so a deploy is never shadowed by a stale edge/
  // browser copy (the bug we hit twice). The app is tiny; re-fetching is cheap.
  onFound: (_path, c) => c.header("Cache-Control", "no-store"),
}));
app.get("/", serveStatic({ path: "./public/index.html" }));
app.notFound((c) => c.text("not found", 404));

await migrate();
// Serve explicitly (one bind). Relying on `export default` makes Bun's entry
// shim bind twice → EADDRINUSE-on-self.
// bind localhost only (the tunnel targets localhost:PORT). Binding 0.0.0.0
// collides with other interfaces already listening on this port (e.g. Tailscale).
Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: app.fetch, maxRequestBodySize: 2_000_000 });
console.log(`◈ NULLPOINT server on :${PORT}  (db ready, secret loaded)`);
