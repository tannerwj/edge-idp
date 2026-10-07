/** Public pages: sign-in, enrollment, consent, sign-out, errors. */
import type { OidcClient, User } from "./db";
import { AuthLayout } from "./ui/layout";
import { Avatar, Callout, initials } from "./ui/components";
import type { Ui } from "./ui/layout";
import { Icon } from "./ui/icons";
import type { IconName } from "./ui/icons";

export function LoginPage(props: {
  ui: Ui;
  next: string;
  app?: { name: string; host: string } | null;
  reauth?: boolean;
  signedOut?: boolean;
}) {
  return (
    <AuthLayout
      ui={props.ui}
      title="Sign in"
      page="login"
      below={
        <span>
          Passkeys only — nothing to remember, nothing to phish. <a href="https://passkeys.dev" rel="noopener">What's a passkey?</a>
        </span>
      }
    >
      {props.signedOut ? (
        <div class="callout ok" role="status">
          <Icon name="check" />
          <div>You're signed out.</div>
        </div>
      ) : null}
      {props.app ? (
        <div class="context-chip">
          <span class="app-glyph">{initials(props.app.name)}</span>
          <div class="grow truncate">
            Continue to <b>{props.app.name}</b>
            <div class="muted tiny truncate">{props.app.host}</div>
          </div>
        </div>
      ) : null}
      <h1>{props.reauth ? "Confirm it's you" : "Sign in"}</h1>
      <p class="lede">
        {props.reauth
          ? "This app asked for a fresh sign-in. Use your passkey to continue."
          : "Use Face ID, Touch ID, Windows Hello, or a security key."}
      </p>
      <div id="login-box" data-next={props.next} class="stack">
        <button id="passkey-btn" class="btn primary lg block" type="button">
          <Icon name="fingerprint" size="lg" />
          <span>Sign in with a passkey</span>
        </button>
        <details class="disclose">
          <summary>
            <Icon name="mail" size="sm" />
            Use a passkey for a specific email
          </summary>
          <label class="field">
            <span class="label">Email</span>
            <input id="email" name="email" type="email" autocomplete="username webauthn" placeholder="you@example.com" />
          </label>
        </details>
        <p id="login-status" class="status" role="status" aria-live="polite"></p>
      </div>
    </AuthLayout>
  );
}

export function EnrollPage(props: { ui: Ui; name: string; email: string; token: string }) {
  return (
    <AuthLayout ui={props.ui} title="Set up your passkey" page="enroll" wide>
      <div class="steps" aria-hidden="true">
        <span class="on"></span>
        <span></span>
      </div>
      <div class="hero-icon">
        <Icon name="fingerprint" />
      </div>
      <h1>Welcome, {props.name.split(" ")[0]}</h1>
      <p class="lede">
        You've been invited to <b>{props.ui.rpName}</b> as <b>{props.email}</b>. Create a passkey and you're done — no
        password, ever.
      </p>
      <ul class="scope-list">
        <li>
          <Icon name="shieldCheck" />
          <div>
            Your passkey lives on this device (or your password manager)
            <span class="sub">The server only ever sees a public key. There's nothing here to steal.</span>
          </div>
        </li>
        <li>
          <Icon name="phone" />
          <div>
            Add a second one later
            <span class="sub">Phone + laptop means losing one device is a non-event.</span>
          </div>
        </li>
      </ul>
      <div id="enroll-box" data-enrollment-token={props.token} class="stack-sm">
        <label class="field">
          <span class="label">Name this passkey (optional)</span>
          <input id="key-name" placeholder="e.g. iPhone, MacBook, YubiKey" maxLength={60} />
        </label>
        <button id="enroll-btn" class="btn primary lg block" type="button">
          <Icon name="fingerprint" size="lg" />
          <span>Create my passkey</span>
        </button>
        <p id="enroll-status" class="status" role="status" aria-live="polite"></p>
      </div>
    </AuthLayout>
  );
}

function hostOf(u: string | null | undefined): string {
  if (!u) return "";
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : `${url.protocol}//`;
  } catch {
    return u;
  }
}

const SCOPE_TEXT: Record<string, { icon: IconName; title: string; sub: string; danger?: boolean }> = {
  openid: { icon: "user", title: "Know who you are", sub: "Your account ID on this server." },
  profile: { icon: "user", title: "See your name", sub: "" },
  email: { icon: "mail", title: "See your email address", sub: "" },
  groups: { icon: "group", title: "See your groups", sub: "Which groups you belong to." },
  offline_access: { icon: "refresh", title: "Stay connected", sub: "Keep access without asking you again, until you disconnect it." },
  mcp: {
    icon: "shield",
    title: "Administer this identity server",
    sub: "Create and change users, groups, apps and clients on your behalf. Only approve tools you trust.",
    danger: true,
  },
  "mcp:read": { icon: "eye", title: "Read admin data", sub: "View users, groups, apps and the audit log (no changes)." },
};

export function ConsentPage(props: {
  ui: Ui;
  client: OidcClient;
  user: User;
  scopes: string[];
  redirectUri: string;
  params: Record<string, string>;
}) {
  const { client } = props;
  const redirectHost = hostOf(props.redirectUri);
  const clientIdHost = client.source === "cimd" ? hostOf(client.id) : null;
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(redirectHost);
  const scopes = props.scopes.filter((s) => s !== "profile" || !props.scopes.includes("openid"));
  return (
    <AuthLayout ui={props.ui} title={`Allow ${client.name}?`} page="consent" wide>
      <div class="consent-apps">
        <span class="bubble">{client.logo_uri ? initials(client.name) : initials(client.name)}</span>
        <span class="link" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </span>
        <span class="bubble me">
          <Icon name="fingerprint" size="lg" />
        </span>
      </div>
      <h1 class="center">
        <b>{client.name}</b> wants to access your account
      </h1>
      <div class="row-sm wrap muted small consent-meta">
        <span class="row-sm">
          <Avatar name={props.user.name} seed={props.user.id} size="sm" /> {props.user.email}
        </span>
      </div>
      <dl class="kv consent-kv">
        {clientIdHost ? (
          <>
            <dt>Published by</dt>
            <dd>
              <span class="badge ok dot">{clientIdHost}</span>
            </dd>
          </>
        ) : null}
        <dt>Sends you back to</dt>
        <dd>
          <span class="mono">{redirectHost}</span>
        </dd>
        <dt>Registered</dt>
        <dd class="muted">
          {client.source === "cimd" ? "Via its own metadata document" : client.source === "dcr" ? "Self-registered (unverified)" : "By an admin"}
        </dd>
      </dl>
      {loopback ? (
        <Callout tone="warn">
          This app runs on your computer (it redirects to <b>{redirectHost}</b>). Only continue if you just started it yourself.
        </Callout>
      ) : null}
      <ul class="scope-list">
        {scopes.map((s) => {
          const t = SCOPE_TEXT[s] ?? { icon: "info", title: s, sub: "" };
          return (
            <li key={s} class={t.danger ? "danger" : ""}>
              <Icon name={t.icon} />
              <div>
                {t.title}
                {t.sub ? <span class="sub">{t.sub}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
      <form method="post" action="/authorize/decision" class="stack-sm">
        {Object.entries(props.params)
          .filter(([k]) => k !== "decision")
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <div class="grid-2">
          <button class="btn lg" type="submit" name="decision" value="deny">
            Cancel
          </button>
          <button class="btn primary lg" type="submit" name="decision" value="allow">
            Allow
          </button>
        </div>
        <p class="muted tiny center">You can disconnect it any time under Account & security.</p>
      </form>
    </AuthLayout>
  );
}

export function SignOutPage(props: { ui: Ui; user: User; params: Record<string, string> }) {
  return (
    <AuthLayout ui={props.ui} title="Sign out">
      <div class="hero-icon">
        <Icon name="logOut" />
      </div>
      <h1>Sign out of {props.ui.rpName}?</h1>
      <p class="lede">
        You're signed in as <b>{props.user.email}</b>. Signing out here signs you out of every app that uses {props.ui.rpName}{" "}
        the next time it checks.
      </p>
      <form method="post" action="/end-session" class="grid-2">
        {Object.entries(props.params).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <a class="btn lg" href="/">
          Stay signed in
        </a>
        <button class="btn primary lg" type="submit">
          Sign out
        </button>
      </form>
    </AuthLayout>
  );
}

export function ErrorPage(props: { ui: Ui; title?: string; message: string }) {
  return (
    <AuthLayout ui={props.ui} title={props.title ?? "Something went wrong"}>
      <div class="hero-icon bad">
        <Icon name="alert" />
      </div>
      <h1>{props.title ?? "Something went wrong"}</h1>
      <p class="lede">{props.message}</p>
      <a class="btn block" href="/">
        Go to {props.ui.rpName}
      </a>
    </AuthLayout>
  );
}
