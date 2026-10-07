/** Server-rendered pages. No inline <script> anywhere — the CSP forbids it;
 *  all behavior lives in /webauthn.js and reads data-* attributes. */

export const THEMES = ["obsidian", "porcelain", "ledger", "dusk", "manuscript", "monochrome"] as const;
export type Theme = (typeof THEMES)[number];

export function Layout(props: {
  title: string;
  rpName: string;
  children: unknown;
  page?: string;
  theme?: string;
  /** Navigation: show account/admin links when the user is signed in. */
  nav?: { isAdmin: boolean; active?: string };
  /** Cache-busting hash for static assets. */
  buildHash?: string;
}) {
  const theme = THEMES.includes(props.theme as Theme) ? props.theme : "obsidian";
  const v = props.buildHash ? `?v=${props.buildHash}` : "";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.title}</title>
        <link rel="stylesheet" href={`/themes/${theme}.css${v}`} />
        <script src={`/webauthn.js${v}`} defer></script>
      </head>
      <body data-page={props.page ?? ""}>
        <main class="shell">
          <div class="card">
            <div class="brand">
              <span class="brand-mark" aria-hidden="true">
                ◆
              </span>
              <span class="brand-name">{props.rpName}</span>
              {props.nav ? (
                <nav class="topnav">
                  <a
                    href="/account"
                    class={props.nav.active === "account" ? "active" : ""}
                  >
                    Account
                  </a>
                  {props.nav.isAdmin ? (
                    <a
                      href="/admin/"
                      class={props.nav.active === "admin" ? "active" : ""}
                    >
                      Admin
                    </a>
                  ) : null}
                </nav>
              ) : null}
            </div>
            {props.children}
          </div>
        </main>
      </body>
    </html>
  );
}

export function LoginPage(props: { rpName: string; next: string; theme?: string ;
  buildHash?: string;}) {
  return (
    <Layout title={`Sign in — ${props.rpName}`} rpName={props.rpName} page="login" theme={props.theme} buildHash={props.buildHash}>
      <h1>Welcome back</h1>
      <p class="muted">Sign in with your passkey — Face ID, Touch ID, or your security key.</p>
      <div id="login-box" data-next={props.next}>
        <label class="field">
          <span>Email</span>
          <input
            id="email"
            name="email"
            type="email"
            autocomplete="username webauthn"
            placeholder="you@example.com"
          />
        </label>
        <button id="passkey-btn" class="btn primary" type="button">
          Continue with passkey
        </button>
        <p id="login-status" class="status" role="status" aria-live="polite"></p>
      </div>
    </Layout>
  );
}

export function EnrollPage(props: {
  rpName: string;
  name: string;
  token: string;
  theme?: string;
  buildHash?: string;
}) {
  return (
    <Layout
      title={`Set up your passkey — ${props.rpName}`}
      rpName={props.rpName}
      page="enroll"
      theme={props.theme}
     buildHash={props.buildHash}>
      <h1>Hi {props.name}</h1>
      <p class="muted">
        Let's set up your passkey. Your device will ask for Face ID, Touch ID,
        or a fingerprint — that's the whole setup.
      </p>
      <div id="enroll-box" data-enrollment-token={props.token}>
        <button id="enroll-btn" class="btn primary" type="button">
          Set up my passkey
        </button>
        <p id="enroll-status" class="status" role="status" aria-live="polite"></p>
        <p class="muted small">
          Tip: add a second passkey afterwards (for example on your phone and
          your laptop) so you're never locked out.
        </p>
      </div>
    </Layout>
  );
}

export function AccountPage(props: {
  rpName: string;
  theme?: string;
  name: string;
  email: string;
  isAdmin: boolean;
  buildHash?: string;
  credentials: { id: string; name: string; created: string; lastUsed: string }[];
}) {
  return (
    <Layout
      title={`Your account — ${props.rpName}`}
      rpName={props.rpName}
      page="account"
      theme={props.theme}
      nav={{ isAdmin: props.isAdmin, active: "account" }}
     buildHash={props.buildHash}>
      <h1>Your account</h1>
      <h2>Profile</h2>
      <form method="post" action="/account/profile" class="stack">
        <label class="field">
          <span>Name</span>
          <input name="name" required maxLength={120} value={props.name} />
        </label>
        <label class="field">
          <span>Email</span>
          <input name="email" type="email" required maxLength={254} value={props.email} />
        </label>
        <div>
          <button class="btn primary" type="submit">
            Save profile
          </button>
        </div>
      </form>
      <h2>Passkeys</h2>
      {props.credentials.length === 0 ? (
        <p class="muted">No passkeys yet.</p>
      ) : (
        <ul class="key-list">
          {props.credentials.map((k) => (
            <li key={k.id}>
              <span class="key-name">{k.name}</span>
              <span class="muted small">
                added {k.created}
                {k.lastUsed ? ` · used ${k.lastUsed}` : ""}
              </span>
              <button
                class="btn danger ghost"
                data-remove-key={k.id}
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div id="account-box">
        <button id="add-key-btn" class="btn" type="button">
          Add another passkey
        </button>
        <p id="account-status" class="status" role="status" aria-live="polite"></p>
      </div>
      <form method="post" action="/logout" class="row">
        <button class="btn ghost" type="submit">
          Sign out
        </button>
      </form>
    </Layout>
  );
}

export function DonePage(props: { rpName: string; title: string; body: string; theme?: string ;
  buildHash?: string;}) {
  return (
    <Layout title={props.title} rpName={props.rpName} theme={props.theme} buildHash={props.buildHash}>
      <h1>{props.title}</h1>
      <p class="muted">{props.body}</p>
      <p>
        <a class="btn primary" href="/">
          Continue
        </a>
      </p>
    </Layout>
  );
}

export function ErrorPage(props: { rpName: string; message: string; theme?: string ;
  buildHash?: string;}) {
  return (
    <Layout title={`Error — ${props.rpName}`} rpName={props.rpName} theme={props.theme} buildHash={props.buildHash}>
      <h1>Something went wrong</h1>
      <p class="muted">{props.message}</p>
      <p>
        <a class="btn" href="/">
          Back to sign in
        </a>
      </p>
    </Layout>
  );
}
