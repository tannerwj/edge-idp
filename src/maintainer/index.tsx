import { maintainerAdmin } from "./console";
import { Hono } from "hono";
import { readBodyLimited } from "../http-body";
import { sha256Hex } from "../util";
import { validShared } from "../feedback-format";
import type { SharedReport, MaintainerReply } from "../feedback-format";

interface Bindings {
  DB: D1Database;
  AUTHORITY?: Fetcher;
  INTAKE_LIMITER: RateLimit;
}
const app = new Hono<{ Bindings: Bindings; Variables: { receipt: string } }>();
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", c.req.path.startsWith("/admin") ? "same-origin" : "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
});
app.route("/admin", maintainerAdmin);
app.get("/", (c) => c.redirect("/admin"));
app.get("/healthz", (c) => c.json({ ok: true }));
app.use("/v1/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  if (!c.env.INTAKE_LIMITER) return c.text("Intake unavailable", 503);
  if (!(await c.env.INTAKE_LIMITER.limit({ key: ip })).success)
    return c.text("Try again later", 429);
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
  if (!match?.[1]) return c.text("Receipt required", 401);
  c.set("receipt", await sha256Hex(match[1]));
  return next();
});
app.put("/v1/report", async (c) => {
  let body: Partial<SharedReport>;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBodyLimited(c.req.raw, 4096)));
  } catch {
    return c.text("Invalid report", 400);
  }
  if (
    !body ||
    !validShared(body) ||
    Object.keys(body).some((k) => !["kind", "summary", "tool_name", "server_version"].includes(k))
  )
    return c.text("Invalid report", 400);
  const hash = c.get("receipt");
  const [, existing] = await c.env.DB.batch<SharedReport>([
    c.env.DB.prepare(
      `INSERT INTO reports(receipt_hash,kind,summary,tool_name,server_version) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM reports WHERE created_at>=unixepoch()-86400)<1000 ON CONFLICT(receipt_hash) DO NOTHING`,
    ).bind(hash, body.kind, body.summary, body.tool_name, body.server_version),
    c.env.DB.prepare(
      "SELECT kind,summary,tool_name,server_version FROM reports WHERE receipt_hash=?",
    ).bind(hash),
  ]);
  const row = existing?.results[0];
  if (!row) return c.text("Intake limit reached", 429);
  if (
    row.kind !== body.kind ||
    row.summary !== body.summary ||
    row.tool_name !== body.tool_name ||
    row.server_version !== body.server_version
  )
    return c.text("Receipt already used", 409);
  return c.json({ received: true });
});
app.get("/v1/report", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT coalesce(p.status,r.status) status,coalesce(p.reply,r.reply) reply,coalesce(p.issue,r.issue) issue FROM reports r LEFT JOIN reports p ON p.id=r.duplicate_of WHERE r.receipt_hash=?`,
  )
    .bind(c.get("receipt"))
    .first<MaintainerReply>();
  return row ? c.json(row) : c.notFound();
});
export default app;
