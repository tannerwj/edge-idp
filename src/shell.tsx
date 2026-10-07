/**
 * Unified app shell for edge-idp. Both the account pages and admin pages
 * render inside this layout so the whole thing feels like one app.
 */
import { BUILD_HASH } from "./assets.gen";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  section?: string;
};

export function AppShell(props: {
  rpName: string;
  title: string;
  theme: string;
  userName: string;
  userEmail: string;
  isAdmin: boolean;
  active: string;
  nav: NavItem[];
  children: unknown;
}) {
  const safe = ["obsidian", "porcelain", "ledger", "dusk", "manuscript", "monochrome"].includes(props.theme)
    ? props.theme
    : "obsidian";

  let lastSection = "";
  const navHtml = props.nav.map((item) => {
    const sectionHeader =
      item.section && item.section !== lastSection ? (
        <div class="nav-section" key={`s-${item.section}`}>
          {item.section}
        </div>
      ) : null;
    lastSection = item.section ?? lastSection;
    return (
      <>
        {sectionHeader}
        <a
          key={item.id}
          href={item.href}
          class={props.active === item.id ? "nav-link active" : "nav-link"}
        >
          {item.label}
        </a>
      </>
    );
  });

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>
          {props.title} · {props.rpName}
        </title>
        <link rel="stylesheet" href={`/themes/${safe}.css?v=${BUILD_HASH}`} />
        <script src={`/webauthn.js?v=${BUILD_HASH}`} defer></script>
      </head>
      <body>
        <div class="app">
          <header class="mobile-bar">
            <label class="hamburger" for="nav-toggle" aria-label="Menu">
              <span></span>
              <span></span>
              <span></span>
            </label>
            <span class="brand-name">{props.rpName}</span>
          </header>
          <input type="checkbox" id="nav-toggle" class="nav-toggle" />
          <aside class="sidebar">
            <div class="brand">
              <span class="brand-mark" aria-hidden="true">◆</span>
              <span class="brand-name">{props.rpName}</span>
            </div>
            <nav class="nav">{navHtml}</nav>
            <div class="sidebar-foot">
              <div class="user-chip">
                <span class="user-name">{props.userName}</span>
                <span class="muted small">{props.userEmail}</span>
              </div>
              <form method="post" action="/logout">
                <button class="btn ghost small" type="submit">Sign out</button>
              </form>
            </div>
          </aside>
          <label class="scrim" for="nav-toggle"></label>
          <main class="content">
            <div class="page">
              <h1 class="page-title">{props.title}</h1>
              {props.children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}

/** Standard nav for account pages. */
export function accountNav(isAdmin: boolean): NavItem[] {
  const nav: NavItem[] = [
    { id: "account", label: "Account", href: "/account", section: "Personal" },
    { id: "tokens", label: "API Tokens", href: "/admin/tokens", section: "Personal" },
    { id: "preferences", label: "Preferences", href: "/admin/preferences", section: "Personal" },
  ];
  if (isAdmin) {
    nav.push(
      { id: "dashboard", label: "Dashboard", href: "/admin", section: "Administration" },
      { id: "users", label: "Users & Groups", href: "/admin/users", section: "Administration" },
      { id: "clients", label: "Apps", href: "/admin/clients", section: "Administration" },
      { id: "access", label: "Access", href: "/admin/access", section: "Administration" },
      { id: "audit", label: "Audit log", href: "/admin/audit", section: "Administration" },
      { id: "metrics", label: "Metrics", href: "/admin/metrics", section: "Administration" },
    );
  }
  return nav;
}

/** Standard nav for admin pages (same as account, admin section highlighted). */
export function adminNav(): NavItem[] {
  return accountNav(true);
}
