/**
 * Page chrome + shared components. Server-rendered with hono/jsx; all
 * behavior lives in /app.js and is wired through data-* attributes (the CSP
 * forbids inline script and style).
 */
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../config";
import { BUILD_HASH } from "../assets.gen";
import { getAccent } from "../settings-cache";
import { raw } from "hono/html";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { Avatar, ConfirmDialog } from "./components";

export type Mode = "system" | "light" | "dark";

export interface Ui {
  rpName: string;
  accent: string;
  mode: Mode;
  /** One-shot message from the previous POST (see setFlash). */
  flash?: { m: string; t: "ok" | "bad" };
}

/**
 * One-shot flash message carried across a POST→redirect→GET. `__Host-`
 * prefixed so no sibling subdomain can plant text on our pages.
 */
const FLASH_COOKIE = "__Host-flash";

export function setFlash(c: Context, message: string, tone: "ok" | "bad" = "ok"): void {
  setCookie(
    c,
    FLASH_COOKIE,
    encodeURIComponent(JSON.stringify({ m: message.slice(0, 300), t: tone })),
    {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 60,
    },
  );
}

function takeFlash(c: Context): Ui["flash"] {
  const cookie = getCookie(c, FLASH_COOKIE);
  if (!cookie) return undefined;
  deleteCookie(c, FLASH_COOKIE, { path: "/", secure: true });
  try {
    const v: unknown = JSON.parse(decodeURIComponent(cookie));
    if (typeof v !== "object" || v === null || !("m" in v) || typeof v.m !== "string")
      return undefined;
    return { m: v.m, t: "t" in v && v.t === "bad" ? "bad" : "ok" };
  } catch {
    return undefined;
  }
}

export async function uiFor<E extends { Bindings: Env }>(c: Context<E>): Promise<Ui> {
  const env: Env = c.env;
  const m = getCookie(c, "ui_mode");
  return {
    rpName: env.RP_NAME,
    accent: await getAccent(env),
    mode: m === "light" || m === "dark" ? m : "system",
    flash: takeFlash(c),
  };
}

/** Fixed flash dictionary — never echo arbitrary text from the URL. */
const FLASH: Record<string, string> = {
  saved: "Changes saved",
  created: "Created",
  deleted: "Deleted",
  revoked: "Revoked",
  signed_out: "Signed out",
  signed_out_others: "Signed out of your other sessions",
  disabled: "User disabled",
  enabled: "User enabled",
  key_added: "Passkey added",
  key_removed: "Passkey removed",
  key_renamed: "Passkey renamed",
  imported: "Imported from Cloudflare Access",
};

/* ───────────────────────────── document ───────────────────────────── */

function Document(props: {
  ui: Ui;
  title: string;
  page?: string;
  children: unknown;
  flash?: string;
  bodyClass?: string;
}) {
  const v = `?v=${BUILD_HASH}`;
  const coded = props.flash ? FLASH[props.flash] : undefined;
  const flash = props.ui.flash ?? (coded ? { m: coded, t: "ok" as const } : undefined);
  // hono/jsx never emits a doctype; without it browsers render in quirks
  // mode (forms grow margins, box sizing differs).
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html
        lang="en"
        data-accent={props.ui.accent}
        {...(props.ui.mode !== "system" ? { "data-mode": props.ui.mode } : {})}
      >
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="color-scheme" content="light dark" />
          <meta name="referrer" content="strict-origin-when-cross-origin" />
          <title>
            {props.title === props.ui.rpName
              ? props.ui.rpName
              : `${props.title} · ${props.ui.rpName}`}
          </title>
          <link rel="icon" href={`/favicon.svg${v}`} type="image/svg+xml" />
          <link rel="stylesheet" href={`/app.css${v}`} />
          <script src={`/app.js${v}`} defer></script>
        </head>
        <body
          data-page={props.page ?? ""}
          class={props.bodyClass}
          {...(flash ? { "data-flash": flash.m, "data-flash-tone": flash.t } : {})}
        >
          {props.children}
          <ConfirmDialog />
          <div class="toasts" id="toasts" aria-live="polite"></div>
        </body>
      </html>
    </>
  );
}

export function BrandMark() {
  return (
    <span class="brand-mark" aria-hidden="true">
      <Icon name="fingerprint" />
    </span>
  );
}

/* ───────────────────────────── centered auth layout ───────────────────────────── */

export function AuthLayout(props: {
  ui: Ui;
  title: string;
  page?: string;
  wide?: boolean;
  children: unknown;
  below?: unknown;
}) {
  return (
    <Document ui={props.ui} title={props.title} page={props.page}>
      <main class="auth">
        <div class="stack-sm">
          <div class={props.wide ? "auth-card wide" : "auth-card"}>
            <a class="auth-brand brand" href="/">
              <BrandMark />
              <span>{props.ui.rpName}</span>
            </a>
            {props.children}
          </div>
          {props.below ? <div class="auth-below">{props.below}</div> : null}
        </div>
      </main>
    </Document>
  );
}

/* ───────────────────────────── app shell ───────────────────────────── */

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  section?: string;
  count?: number;
}

export interface Viewer {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

export function navFor(isAdmin: boolean): NavItem[] {
  const nav: NavItem[] = [
    { id: "home", label: "Home", href: "/", icon: "home" },
    { id: "account", label: "Account & security", href: "/account", icon: "shieldCheck" },
  ];
  if (!isAdmin) return nav;
  return [
    ...nav,
    { id: "overview", label: "Overview", href: "/admin", icon: "activity", section: "Manage" },
    { id: "users", label: "People", href: "/admin/users", icon: "users", section: "Manage" },
    { id: "groups", label: "Groups", href: "/admin/groups", icon: "group", section: "Manage" },
    { id: "apps", label: "Apps", href: "/admin/apps", icon: "grid", section: "Manage" },
    { id: "clients", label: "Clients", href: "/admin/clients", icon: "plug", section: "Manage" },
    { id: "audit", label: "Audit log", href: "/admin/audit", icon: "list", section: "Manage" },
    {
      id: "connect",
      label: "Connect",
      href: "/admin/connect",
      icon: "link",
      section: "Developers",
    },
    {
      id: "tokens",
      label: "API tokens",
      href: "/admin/tokens",
      icon: "key",
      section: "Developers",
    },
    {
      id: "metrics",
      label: "MCP activity",
      href: "/admin/metrics",
      icon: "bot",
      section: "Developers",
    },
    {
      id: "settings",
      label: "Settings",
      href: "/admin/settings",
      icon: "settings",
      section: "Developers",
    },
  ];
}

export interface Crumb {
  label: string;
  href?: string;
}

function SidebarNav({ nav, active }: { nav: NavItem[]; active: string }) {
  return (
    <nav class="nav">
      {nav.map((item, i) => {
        const header =
          item.section && item.section !== nav[i - 1]?.section ? (
            <div class="nav-section" key={`s-${item.section}`}>
              {item.section}
            </div>
          ) : null;
        return (
          <>
            {header}
            <a
              href={item.href}
              class={active === item.id ? "nav-link active" : "nav-link"}
              {...(active === item.id ? { "aria-current": "page" } : {})}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          </>
        );
      })}
    </nav>
  );
}

function ModeToggle({ mode }: { mode: Mode }) {
  return (
    <div class="mode-toggle" role="group" aria-label="Color mode">
      <button
        type="button"
        data-mode-set="light"
        aria-pressed={mode === "light" ? "true" : "false"}
        title="Light"
      >
        <Icon name="sun" size="sm" />
      </button>
      <button
        type="button"
        data-mode-set="system"
        aria-pressed={mode === "system" ? "true" : "false"}
        title="Match system"
      >
        <Icon name="laptop" size="sm" />
      </button>
      <button
        type="button"
        data-mode-set="dark"
        aria-pressed={mode === "dark" ? "true" : "false"}
        title="Dark"
      >
        <Icon name="moon" size="sm" />
      </button>
    </div>
  );
}

function ViewerMenu({ viewer }: { viewer: Viewer }) {
  return (
    <div class="me">
      <Avatar name={viewer.name} seed={viewer.id} />
      <a class="who" href="/account">
        <div class="n truncate">{viewer.name}</div>
        <div class="e truncate">{viewer.email}</div>
      </a>
      <form method="post" action="/logout">
        <button class="btn ghost icon sm" type="submit" title="Sign out" aria-label="Sign out">
          <Icon name="logOut" size="sm" />
        </button>
      </form>
    </div>
  );
}

function Sidebar({ ui, viewer, active }: { ui: Ui; viewer: Viewer; active: string }) {
  return (
    <aside class="sidebar" aria-label="Main navigation">
      <a class="brand" href="/">
        <BrandMark />
        <span class="truncate">{ui.rpName}</span>
      </a>
      <button class="search-trigger" type="button" data-open-palette>
        <Icon name="search" size="sm" />
        <span>Search or jump to…</span>
        <span class="kbd">⌘K</span>
      </button>
      <SidebarNav nav={navFor(viewer.isAdmin)} active={active} />
      <div class="sidebar-foot">
        <ModeToggle mode={ui.mode} />
        <ViewerMenu viewer={viewer} />
      </div>
    </aside>
  );
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav class="crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <>
          {i > 0 ? <span class="sep">/</span> : null}
          {c.href ? <a href={c.href}>{c.label}</a> : <span class="here truncate">{c.label}</span>}
        </>
      ))}
    </nav>
  );
}

function CommandPalette() {
  return (
    <dialog class="palette" id="palette" aria-label="Command palette">
      <div class="palette-input">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Jump to a page, person, or app…"
          autocomplete="off"
          spellcheck={false}
          data-palette-input
        />
        <span class="kbd">esc</span>
      </div>
      <ul class="palette-list" data-palette-list role="listbox"></ul>
      <div class="palette-foot">
        <span>↑↓ to navigate</span>
        <span>↵ to open</span>
      </div>
    </dialog>
  );
}

export function AppShell(props: {
  ui: Ui;
  viewer: Viewer;
  active: string;
  title: string;
  crumbs?: Crumb[];
  page?: string;
  flash?: string;
  narrow?: boolean;
  children: unknown;
}) {
  const crumbs = props.crumbs ?? [{ label: props.title }];
  return (
    <Document
      ui={props.ui}
      title={props.title}
      page={props.page ?? props.active}
      flash={props.flash}
    >
      <div class="app">
        <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true" />
        <Sidebar ui={props.ui} viewer={props.viewer} active={props.active} />
        <label class="scrim" for="nav-toggle"></label>
        <div class="main">
          <header class="topbar">
            <label class="btn ghost icon menu-btn" for="nav-toggle" aria-label="Menu">
              <Icon name="menu" />
            </label>
            <Breadcrumbs crumbs={crumbs} />
            <button
              class="btn ghost icon right"
              type="button"
              data-open-palette
              aria-label="Search"
            >
              <Icon name="search" />
            </button>
          </header>
          <main class={props.narrow ? "content narrow" : "content"}>{props.children}</main>
        </div>
      </div>
      <CommandPalette />
    </Document>
  );
}
