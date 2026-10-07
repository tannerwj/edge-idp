import { Hono } from "hono";
import type { Context } from "hono";
import * as Sentry from "@sentry/cloudflare";
import { assertConfigured, isLocalIssuer } from "./config";
import { resolveEnv } from "./instance";
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
import { setup, setupPending } from "./setup";
import { checkForUpdate } from "./upstream";
import { APP_CSS, APP_JS } from "./assets.gen";

const app = new Hono<{ Bindings: Env }>();

const TOKEN_ENDPOINTS = ["/token", "/revoke", "/register", "/userinfo", "/mcp"];

function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

function crossOrigin(c: Context<{ Bindings: Env }>): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = c.req.header("origin");
  return !!origin && origin !== c.env.ISSUER;
}

function limiterFor(env: Env, path: string): RateLimit | undefined {
  if (
    path.startsWith("/webauthn/") ||
    path === "/register" ||
    path === "/authorize/decision" ||
    path === "/setup"
  )
    return env.AUTH_LIMITER;
  if (path === "/authorize" || path === "/token" || path === "/revoke" || path.startsWith("/mcp"))
    return env.API_LIMITER;
  return undefined;
}

function canonicalResponse(c: Context<{ Bindings: Env }>, url: URL): Response | null {
  if (url.origin === c.env.ISSUER || isLocalIssuer(c.env.ISSUER)) return null;
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.redirect(`${c.env.ISSUER}${url.pathname}${url.search}`, 308);
  }
  return c.text("Use the configured issuer hostname.", 421);
}

// eslint-disable-next-line typescript/consistent-return
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.length > 1 && url.pathname.endsWith("/") && c.req.method === "GET") {
    url.pathname = url.pathname.slice(0, -1);
    return c.redirect(url.toString(), 301);
  }
  try {
    c.env = await resolveEnv(c.env, c.req.url);
    assertConfigured(c.env);
  } catch (e) {
    console.error(e);
    return c.text("Server misconfigured — see DEPLOY.md.", 500);
  }
  const canonical = canonicalResponse(c, url);
  if (canonical) return canonical;
  const path = url.pathname;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  const tokenEndpoint = TOKEN_ENDPOINTS.some((p) => path === p || path.startsWith(`${p}/`));

  if ((path === "/setup" || path === "/register") && !c.env.AUTH_LIMITER) {
    return c.json({ error: "temporarily_unavailable" }, 503);
  }

  if (mutating && !tokenEndpoint && crossOrigin(c)) {
    return c.text("Cross-origin request refused.", 403);
  }

  const limiter = limiterFor(c.env, path);
  if (limiter && (mutating || path === "/authorize")) {
    const { success } = await limiter.limit({ key: `${path.split("/")[1]}:${clientIp(c)}` });
    if (!success)
      return c.json(
        { error: "rate_limited", error_description: "Too many requests — slow down." },
        429,
        { "retry-after": "60" },
      );
  }

  await next();

  const h = c.res.headers;
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  );
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  );
  if ((h.get("content-type") ?? "").startsWith("text/html") && !h.has("cache-control")) {
    h.set("cache-control", "no-store");
  }
});

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d5ef6"/><stop offset="1" stop-color="#3b3bb8"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" transform="translate(4 4)"><path d="M12 10a2 2 0 0 0-2 2c0 1-.1 2.5-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></g></svg>`;

const immutable = { "cache-control": "public, max-age=31536000, immutable" };
app.get("/app.css", (c) =>
  c.body(APP_CSS, 200, { "content-type": "text/css; charset=utf-8", ...immutable }),
);
app.get("/app.js", (c) =>
  c.body(APP_JS, 200, { "content-type": "text/javascript; charset=utf-8", ...immutable }),
);
app.get("/favicon.svg", (c) =>
  c.body(FAVICON, 200, { "content-type": "image/svg+xml", ...immutable }),
);
app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
app.get("/healthz", (c) => c.json({ ok: true }));

function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  return "/";
}

async function loginContext(
  db: D1Database,
  next: string,
): Promise<{ name: string; host: string } | null> {
  if (!next.startsWith("/authorize?")) return null;
  const q = new URLSearchParams(next.slice("/authorize?".length));
  const client = await getClient(db, q.get("client_id") ?? "");
  if (!client) return null;
  let host = "";
  try {
    host = new URL(q.get("redirect_uri") ?? client.redirect_uris[0] ?? "").host;
  } catch {}
  return { name: client.name, host };
}

app.get("/login", async (c) => {
  if (await setupPending(c.env.DB)) return c.redirect("/setup", 302);
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

app.get("/enroll", async (c) =>
  c.html(<EnrollPage ui={await uiFor(c)} />, 200, {
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  }),
);

app.get("/enroll/:token", async (c) => {
  const v = await validEnrollmentToken(c.env.DB, c.req.param("token"));
  const ui = await uiFor(c);
  if (!v) {
    return c.html(
      <ErrorPage
        ui={ui}
        title="This link has expired"
        message="Enrollment links work once and last 7 days. Ask your admin for a fresh one."
      />,
      400,
    );
  }
  return c.html(
    <EnrollPage ui={ui} name={v.user.name} email={v.user.email} token={c.req.param("token")} />,
    200,
    {
      "referrer-policy": "no-referrer",
    },
  );
});

app.post("/logout", async (c) => {
  const session = await getSession(c);
  if (session) await audit(c.env.DB, "SIGN_OUT", { userId: session.user.id });
  await destroySession(c);
  return c.redirect("/login?signed_out=1", 303);
});

app.route("/", setup);
app.route("/webauthn", webauthn);
app.route("/admin", admin);
app.route("/mcp", mcp);
app.route("/", registration);
app.route("/", oidc);
app.route("/", tokens);
app.route("/", account);
app.route("/", home);

app.notFound(async (c) =>
  c.html(
    <ErrorPage
      ui={await uiFor(c)}
      title="Page not found"
      message="That page doesn't exist (or moved in the redesign)."
    />,
    404,
  ),
);

app.onError(async (err, c) => {
  Sentry.captureException(err);
  console.error(err);
  if (c.req.header("accept")?.includes("text/html")) {
    return c.html(
      <ErrorPage
        ui={await uiFor(c)}
        message="Something broke on our side. It's been logged — try again in a moment."
      />,
      500,
    );
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
      ctx.waitUntil(
        checkForUpdate(env).then((r) => {
          if (r !== "skipped") console.log(JSON.stringify({ msg: "update_check", result: r }));
          return r;
        }),
      );
    },
  } satisfies ExportedHandler<Env>,
);

export { IdCodeSandbox } from "./mcp";
