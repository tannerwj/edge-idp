import { Hono } from "hono";
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
import { audit, getCredentialsForUser } from "./db";
import { STYLES_CSS, WEBAUTHN_JS } from "./assets.gen";

const app = new Hono<{ Bindings: Env }>();

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

app.get("/styles.css", (c) =>
  c.body(STYLES_CSS, 200, {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=3600",
  }),
);
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
  return c.html(<LoginPage rpName={c.env.RP_NAME} next={next} />);
});

app.get("/enroll/:token", async (c) => {
  const v = await validEnrollmentToken(c.env.DB, c.req.param("token"));
  if (!v) {
    return c.html(
      <ErrorPage
        rpName={c.env.RP_NAME}
        message="This enrollment link is invalid, expired, or already used. Ask your admin for a new one."
      />,
      400,
    );
  }
  return c.html(
    <EnrollPage
      rpName={c.env.RP_NAME}
      name={v.user.name}
      token={c.req.param("token")}
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

app.post("/logout", async (c) => {
  const user = await sessionUser(c);
  if (user) await audit(c.env.DB, "SIGN_OUT", { userId: user.id });
  await destroySession(c);
  return c.redirect("/login", 303);
});

app.get("/done", (c) =>
  c.html(
    <DonePage
      rpName={c.env.RP_NAME}
      title="You're signed in"
      body="You can close this tab and return to the app."
    />,
  ),
);

app.route("/webauthn", webauthn);
app.route("/admin", admin);
// OIDC routes live at absolute paths (/.well-known/…, /authorize, …).
app.route("/", oidc);

app.notFound((c) =>
  c.html(
    <ErrorPage rpName={c.env.RP_NAME ?? "Identity"} message="Page not found." />,
    404,
  ),
);

export default app;
