import { Hono } from "hono";
import type { Context } from "hono";
import * as Sentry from "@sentry/cloudflare";
import { assertConfigured } from "./config";
import type { Env } from "./config";
import { webauthn, validEnrollmentToken } from "./webauthn";
import { oidc } from "./oidc";
import { tokens } from "./oauth-token";
import { registration } from "./oauth-clients";
import { admin } from "./admin";
import { account } from "./account";
import { home } from "./home";
import { mcp } from "./mcp";
import { EnrollPage, ErrorPage, LoginPage } from "./pages";
import { destroySession, getSession } from "./session";
import { audit, getClient } from "./db";
import { uiFor } from "./ui/layout";
import { runMaintenance } from "./maintenance";
import { APP_CSS, APP_JS } from "./assets.gen";

const app = new Hono<{ Bindings: Env }>();

/** Endpoints authenticated by bearer tokens / client secrets, never cookies. */
const TOKEN_ENDPOINTS = ["/token", "/revoke", "/register", "/userinfo", "/mcp"];

function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/**
 * Same-origin guard for every cookie-authenticated state change.
 *
 * Threat note: SameSite=Lax only blocks cross-*site* requests, and every
 * other host on this registrable domain (app.example.com next to
 * auth.example.com) is same-site. Fetch Metadata / Origin pin mutations to
 * this exact origin. Requests with neither header aren't from a browser that
 * would attach our cookie cross-origin, so they pass.
 */
function crossOrigin(c: Context<{ Bindings: Env }>): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = c.req.header("origin");
  return !!origin && origin !== c.env.ISSUER;
}

// Hono middleware intentionally returns Response | void (short-circuit or pass-through).
// eslint-disable-next-line typescript/consistent-return
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  // Normalize trailing slashes: /admin/ -> /admin (except root /).
  if (url.pathname.length > 1 && url.pathname.endsWith("/") && c.req.method === "GET") {
    url.pathname = url.pathname.slice(0, -1);
    return c.redirect(url.toString(), 301);
  }
  try {
    assertConfigured(c.env);
  } catch {
    return c.text("Server misconfigured — see DEPLOY.md.", 500);
  }
  const path = url.pathname;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  const tokenEndpoint = TOKEN_ENDPOINTS.some((p) => path === p || path.startsWith(`${p}/`));

  if (mutating && !tokenEndpoint && crossOrigin(c)) {
    return c.text("Cross-origin request refused.", 403);
  }

  // Optional Workers Rate Limiting bindings: ceremonies + registration on
  // one budget, token/API traffic on another. Keyed per client IP.
  const limiter =
    path.startsWith("/webauthn/") || path === "/register" || path === "/authorize/decision"
      ? c.env.AUTH_LIMITER
      : path === "/token" || path === "/revoke" || path.startsWith("/mcp")
        ? c.env.API_LIMITER
        : undefined;
  if (limiter && mutating) {
    const { success } = await limiter.limit({ key: `${path.split("/")[1]}:${clientIp(c)}` });
    if (!success) return c.json({ error: "rate_limited", error_description: "Too many requests — slow down." }, 429, { "retry-after": "60" });
  }

  await next();

  const h = c.res.headers;
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)");
  // No inline scripts/styles anywhere in the app, so this can stay strict.
  // No form-action: the consent POST 302s to the client's redirect URI,
  // browsers apply form-action to that redirect, and native clients use
  // schemes (cursor://, vscode://) no allowlist can enumerate. Every form is
  // server-rendered with escaped content, so there's no injected form to stop.
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  );
  // Authenticated HTML must never be cached by browsers or proxies.
  if ((h.get("content-type") ?? "").startsWith("text/html") && !h.has("cache-control")) {
    h.set("cache-control", "no-store");
  }
});

/* ───────────────────────────── static assets ───────────────────────────── */

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d5ef6"/><stop offset="1" stop-color="#3b3bb8"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" transform="translate(4 4)"><path d="M12 10a2 2 0 0 0-2 2c0 1-.1 2.5-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></g></svg>`;

const immutable = { "cache-control": "public, max-age=31536000, immutable" };
app.get("/app.css", (c) => c.body(APP_CSS, 200, { "content-type": "text/css; charset=utf-8", ...immutable }));
app.get("/app.js", (c) => c.body(APP_JS, 200, { "content-type": "text/javascript; charset=utf-8", ...immutable }));
app.get("/favicon.svg", (c) => c.body(FAVICON, 200, { "content-type": "image/svg+xml", ...immutable }));
app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
app.get("/healthz", (c) => c.json({ ok: true }));

/* ───────────────────────────── sign-in / enrollment ───────────────────────────── */

/** Only same-origin relative paths — never bounce a fresh login elsewhere. */
function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  return "/";
}

/** "Continue to <app>" context when the login was triggered by /authorize. */
async function loginContext(db: D1Database, next: string): Promise<{ name: string; host: string } | null> {
  if (!next.startsWith("/authorize?")) return null;
  const q = new URLSearchParams(next.slice("/authorize?".length));
  const client = await getClient(db, q.get("client_id") ?? "");
  if (!client) return null;
  let host = "";
  try {
    host = new URL(q.get("redirect_uri") ?? client.redirect_uris[0] ?? "").host;
  } catch {
    /* leave blank */
  }
  return { name: client.name, host };
}

app.get("/login", async (c) => {
  const session = await getSession(c);
  const next = safeNext(c.req.query("next"));
  const reauth = c.req.query("reauth") === "1";
  if (session && !reauth) return c.redirect(next, 302);
  return c.html(
    <LoginPage
      ui={await uiFor(c)}
      next={next}
      app={await loginContext(c.env.DB, next)}
      reauth={reauth && !!session}
      signedOut={c.req.query("signed_out") === "1"}
    />,
  );
});

app.get("/enroll/:token", async (c) => {
  const v = await validEnrollmentToken(c.env.DB, c.req.param("token"));
  const ui = await uiFor(c);
  if (!v) {
    return c.html(
      <ErrorPage ui={ui} title="This link has expired" message="Enrollment links work once and last 7 days. Ask your admin for a fresh one." />,
      400,
    );
  }
  return c.html(<EnrollPage ui={ui} name={v.user.name} email={v.user.email} token={c.req.param("token")} />, 200, {
    "referrer-policy": "no-referrer",
  });
});

app.post("/logout", async (c) => {
  const session = await getSession(c);
  if (session) await audit(c.env.DB, "SIGN_OUT", { userId: session.user.id });
  await destroySession(c);
  return c.redirect("/login?signed_out=1", 303);
});

/* ───────────────────────────── routes ───────────────────────────── */

app.route("/webauthn", webauthn);
app.route("/admin", admin);
app.route("/mcp", mcp);
app.route("/", registration);
// OIDC routes live at absolute paths (/.well-known/…, /authorize, …).
app.route("/", oidc);
app.route("/", tokens);
app.route("/", account);
app.route("/", home);

app.notFound(async (c) =>
  c.html(<ErrorPage ui={await uiFor(c)} title="Page not found" message="That page doesn't exist (or moved in the redesign)." />, 404),
);

app.onError(async (err, c) => {
  Sentry.captureException(err);
  console.error(err);
  if (c.req.header("accept")?.includes("text/html")) {
    return c.html(<ErrorPage ui={await uiFor(c)} message="Something broke on our side. It's been logged — try again in a moment." />, 500);
  }
  return c.json({ error: "server_error" }, 500);
});

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  }),
  {
    fetch: app.fetch,
    async scheduled(_event, env, ctx) {
      ctx.waitUntil(
        runMaintenance(env.DB).then((r) => {
          console.log(JSON.stringify({ msg: "maintenance", ...r }));
          return r;
        }),
      );
    },
  } satisfies ExportedHandler<Env>,
);

// Code-mode sandbox entrypoint (must be exported for ctx.exports).
export { IdCodeSandbox } from "./mcp";
