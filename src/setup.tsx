/**
 * First-run setup for one-click installs: create the first admin, then hand
 * off to the normal passkey enrollment page.
 *
 * Threat note: /setup exists only while the users table is empty, and only
 * with the SETUP_TOKEN secret the installer typed at deploy time. It's on the
 * AUTH rate limit, compared in constant time, and the insert itself is
 * conditional on "no users yet", so two racing requests can't both win. Once
 * any user exists it 404s for good (instances seeded with scripts/seed-admin
 * never see it).
 */
import { Hono } from "hono";
import type { Env } from "./config";
import { audit } from "./db";
import { mintEnrollmentLink } from "./ops";
import { AuthLayout, uiFor } from "./ui/layout";
import type { Ui } from "./ui/layout";
import { Callout } from "./ui/components";
import { Icon } from "./ui/icons";
import { newId, nowSec, sha256Hex, timingSafeEqualHex } from "./util";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_TOKEN = 12;

let done = false;

/** True until the first user exists (then cached for the isolate's lifetime). */
export async function setupPending(db: D1Database): Promise<boolean> {
  if (done) return false;
  const any = await db.prepare("SELECT 1 AS x FROM users LIMIT 1").first();
  if (any) done = true;
  return !done;
}

function SetupPage(props: { ui: Ui; ready: boolean; error?: string; name?: string; email?: string }) {
  return (
    <AuthLayout ui={props.ui} title="Set up" page="setup" wide>
      <div class="hero-icon">
        <Icon name="sparkles" />
      </div>
      <h1>Welcome to {props.ui.rpName}</h1>
      {props.ready ? (
        <>
          <p class="lede">Create the first admin account. Next you'll make a passkey for it, and you're in.</p>
          {props.error ? <Callout tone="bad">{props.error}</Callout> : null}
          <form method="post" action="/setup" class="stack-sm">
            <label class="field">
              <span class="label">Setup token</span>
              <input name="token" type="password" required autocomplete="off" />
              <span class="hint">The SETUP_TOKEN you chose when you deployed.</span>
            </label>
            <label class="field">
              <span class="label">Your name</span>
              <input name="name" required maxLength={120} value={props.name ?? ""} autocomplete="name" />
            </label>
            <label class="field">
              <span class="label">Email</span>
              <input name="email" type="email" required maxLength={254} value={props.email ?? ""} autocomplete="email" />
            </label>
            <button class="btn primary lg block" type="submit">
              <span>Create admin</span>
              <Icon name="arrowRight" />
            </button>
          </form>
        </>
      ) : (
        <Callout tone="warn">
          Set a <code>SETUP_TOKEN</code> secret ({MIN_TOKEN}+ characters) on this Worker, then reload. Or create the
          first admin from a terminal with <code>node scripts/seed-admin.mjs</code> (see DEPLOY.md).
        </Callout>
      )}
    </AuthLayout>
  );
}

export const setup = new Hono<{ Bindings: Env }>();

setup.get("/setup", async (c) => {
  if (!(await setupPending(c.env.DB))) return c.notFound();
  const ready = (c.env.SETUP_TOKEN ?? "").length >= MIN_TOKEN;
  return c.html(<SetupPage ui={await uiFor(c)} ready={ready} />, 200, { "referrer-policy": "no-referrer" });
});

setup.post("/setup", async (c) => {
  if (!(await setupPending(c.env.DB))) return c.notFound();
  const expected = c.env.SETUP_TOKEN ?? "";
  if (expected.length < MIN_TOKEN) return c.notFound();
  const form = await c.req.parseBody();
  const str = (k: string) => (typeof form[k] === "string" ? form[k].trim() : "");
  const name = str("name").slice(0, 120);
  const email = str("email").slice(0, 254);
  const ui = await uiFor(c);
  const again = (error: string, status: 400 | 401) => c.html(<SetupPage ui={ui} ready error={error} name={name} email={email} />, status);

  if (!timingSafeEqualHex(await sha256Hex(str("token")), await sha256Hex(expected))) {
    const ip = c.req.header("cf-connecting-ip");
    await audit(c.env.DB, "SETUP_REJECTED", { ipHash: ip ? await sha256Hex(ip) : null });
    return again("That setup token doesn't match.", 401);
  }
  if (!name) return again("Name is required.", 400);
  if (!EMAIL_RE.test(email)) return again("Enter a valid email address.", 400);

  const id = newId();
  const now = nowSec();
  const res = await c.env.DB.prepare(
    "INSERT INTO users (id, created_at, name, email, is_admin, updated_at) SELECT ?1, ?2, ?3, ?4, 1, ?2 WHERE NOT EXISTS (SELECT 1 FROM users)",
  )
    .bind(id, now, name, email)
    .run();
  if (res.meta.changes !== 1) {
    done = true;
    return c.notFound();
  }
  done = true;
  await audit(c.env.DB, "SETUP_COMPLETED", { userId: id });
  const link = await mintEnrollmentLink(c.env.DB, c.env.ISSUER, id, { adminId: id, via: "ui" });
  return c.redirect(new URL(link).pathname, 303);
});
