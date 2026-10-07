import { Hono } from "hono";
import * as Sentry from "@sentry/cloudflare";
import { assertConfigured } from "./config";
import type { Env } from "./config";
import { webauthn, validEnrollmentToken } from "./webauthn";
import { oidc } from "./oidc";
import { admin } from "./admin";
import {
  AccountPage,
  DonePage,
  EnrollPage,
  ErrorPage,
  LoginPage,
} from "./pages";
import { destroySession, sessionUser } from "./session";
import { audit, getCredentialsForUser, getSetting } from "./db";
import { getTheme } from "./theme-cache";
import { THEMES_CSS, WEBAUTHN_JS } from "./assets.gen";

const app = new Hono<{ Bindings: Env }>();

async function theme(c: { env: Env }): Promise<string> {
  return getTheme(c.env);
}

/**
 * Security headers on EVERY response (coding standard). Static assets are
 * served from memory through these same routes so nothing bypasses this.
 */
// Hono middleware intentionally returns Response | void (short-circuit or pass-through).
// eslint-disable-next-line typescript/consistent-return
app.use("*", async (c, next) => {
  try {
    assertConfigured(c.env);
  } catch {
    return c.text("Server misconfigured — see DEPLOY.md.", 500);
  }
  await next();
  const h = c.res.headers;
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  // No inline scripts/styles anywhere in the app, so this can stay strict.
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
});

app.get("/themes/:name.css", (c) => {
  const raw = c.req.param("name.css") ?? "";
  const name = raw.replace(/\.css$/, "");
  const css = THEMES_CSS[name];
  if (!css) return c.text("Unknown theme", 404);
  return c.body(css, 200, {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=3600",
  });
});
app.get("/webauthn.js", (c) =>
  c.body(WEBAUTHN_JS, 200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=3600",
  }),
);

/** Only same-origin relative paths — never bounce a fresh login elsewhere. */
function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/account";
}

app.get("/", async (c) => {
  const user = await sessionUser(c);
  return c.redirect(user ? "/account" : "/login", 302);
});

app.get("/login", async (c) => {
  const user = await sessionUser(c);
  const next = safeNext(c.req.query("next"));
  if (user) return c.redirect(next, 302);
  return c.html(
    <LoginPage rpName={c.env.RP_NAME} next={next} theme={await theme(c)} />,
  );
});

app.get("/enroll/:token", async (c) => {
  const v = await validEnrollmentToken(c.env.DB, c.req.param("token"));
  if (!v) {
    return c.html(
      <ErrorPage
        rpName={c.env.RP_NAME}
        message="This enrollment link is invalid, expired, or already used. Ask your admin for a new one."
        theme={await theme(c)}
      />,
      400,
    );
  }
  return c.html(
    <EnrollPage
      rpName={c.env.RP_NAME}
      name={v.user.name}
      token={c.req.param("token")}
      theme={await theme(c)}
    />,
  );
});

app.get("/account", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login?next=/account", 302);
  const creds = await getCredentialsForUser(c.env.DB, user.id);
  return c.html(
    <AccountPage
      rpName={c.env.RP_NAME}
      name={user.name}
      email={user.email}
      isAdmin={!!user.is_admin}
      theme={await theme(c)}
      credentials={creds.map((k) => ({
        id: k.id,
        name: k.name,
        created: new Date(k.created_at * 1000).toLocaleDateString(),
        lastUsed: k.last_used_at
          ? new Date(k.last_used_at * 1000).toLocaleDateString()
          : "",
      }))}
    />,
  );
});

app.post("/account/keys/:id/remove", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const creds = await getCredentialsForUser(c.env.DB, user.id);
  // Fail safe: never let a user strand themselves with zero passkeys outside
  // an admin-assisted recovery. The error tells them exactly what to do.
  if (creds.length <= 1) {
    return c.json(
      {
        error:
          "This is your last passkey. Add another one first, or ask your admin to re-enroll you.",
      },
      400,
    );
  }
  const target = creds.find((k) => k.id === c.req.param("id"));
  if (!target) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("DELETE FROM webauthn_credentials WHERE id = ?1")
    .bind(target.id)
    .run();
  await audit(c.env.DB, "PASSKEY_REMOVED", {
    userId: user.id,
    detail: { credential: target.id, name: target.name },
  });
  return c.json({ ok: true });
});

app.post("/account/profile", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login?next=/account", 302);
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim().slice(0, 120);
  const email = String(form.email ?? "").trim().slice(0, 254);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const err = async (message: string) =>
    c.html(
      <ErrorPage rpName={c.env.RP_NAME} message={message} theme={await theme(c)} />,
      400,
    );
  if (!name) return err("Name is required.");
  if (!emailOk) return err("Enter a valid email address.");
  if (email.toLowerCase() !== user.email.toLowerCase()) {
    const clash = await c.env.DB.prepare(
      "SELECT id FROM users WHERE lower(email) = lower(?1) AND id != ?2",
    )
      .bind(email, user.id)
      .first();
    if (clash) return err("That email is already in use by another account.");
  }
  await c.env.DB.prepare(
    "UPDATE users SET name = ?1, email = ?2, updated_at = ?3 WHERE id = ?4",
  )
    .bind(name, email, Math.floor(Date.now() / 1000), user.id)
    .run();
  await audit(c.env.DB, "PROFILE_UPDATED", {
    userId: user.id,
    detail: { nameChanged: name !== user.name, emailChanged: email !== user.email },
  });
  return c.redirect("/account", 303);
});

app.post("/logout", async (c) => {
  const user = await sessionUser(c);
  if (user) await audit(c.env.DB, "SIGN_OUT", { userId: user.id });
  await destroySession(c);
  return c.redirect("/login", 303);
});

app.get("/done", async (c) =>
  c.html(
    <DonePage
      rpName={c.env.RP_NAME}
      title="You're signed in"
      body="You can close this tab and return to the app."
      theme={await theme(c)}
    />,
  ),
);

app.route("/webauthn", webauthn);
app.route("/admin", admin);
// OIDC routes live at absolute paths (/.well-known/…, /authorize, …).
app.route("/", oidc);

app.notFound(async (c) =>
  c.html(
    <ErrorPage
      rpName={c.env.RP_NAME ?? "Identity"}
      message="Page not found."
      theme={await theme(c)}
    />,
    404,
  ),
);

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  }),
  app,
);
