import type { ACtx } from "../shell";
import { page } from "../shell";
import { PageHead } from "../../ui/components";
import { Icon } from "../../ui/icons";
import type { IconName } from "../../ui/icons";
import { getInstanceSettings } from "../../settings-cache";
import type { InstanceSettings } from "../../settings-cache";
import { emailStatus } from "../../email";
import { cfConfigured } from "../../cf-access";
import type { Env } from "../../config";

export type SettingsTab =
  | "general"
  | "sign-in"
  | "email"
  | "notifications"
  | "clients"
  | "keys"
  | "cloudflare"
  | "about";

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: IconName;
  lede: string;
}

export const SETTINGS_TABS: TabDef[] = [
  {
    id: "general",
    label: "General",
    icon: "settings",
    lede: "The instance name and how it looks for everyone.",
  },
  {
    id: "sign-in",
    label: "Sign-in & security",
    icon: "shield",
    lede: "How people prove who they are, and when admins have to prove it again.",
  },
  {
    id: "email",
    label: "Email",
    icon: "mail",
    lede: "Optional. Lets this server send invites, sign-in links and security notices.",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: "bell",
    lede: "Alerts for admins, webhooks, and security notices to the people affected.",
  },
  {
    id: "clients",
    label: "Client onboarding",
    icon: "bot",
    lede: "How AI tools and other third-party clients may introduce themselves.",
  },
  {
    id: "keys",
    label: "Identity & keys",
    icon: "key",
    lede: "The issuer apps trust and the keys that sign their tokens.",
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    icon: "cloud",
    lede: "Optional. Read your Access applications into the launcher.",
  },
  {
    id: "about",
    label: "About",
    icon: "info",
    lede: "Version, updates, feedback and what this instance is running with.",
  },
];

export function tabHref(id: SettingsTab): string {
  return id === "general" ? "/admin/settings" : `/admin/settings/${id}`;
}

type Badge = { text: string; tone: "ok" | "warn" | "" } | null;

function badgeFor(id: SettingsTab, env: Env, s: InstanceSettings): Badge {
  if (id === "email") {
    const st = emailStatus(env, s);
    if (st === "ready") return { text: "On", tone: "ok" };
    return { text: st === "off" ? "Off" : "Not set up", tone: "" };
  }
  if (id === "sign-in" && (s.signInUv === "discouraged" || s.adminStepUp === "off"))
    return { text: "Relaxed", tone: "warn" };
  if (id === "cloudflare" && cfConfigured(env)) return { text: "Connected", tone: "ok" };
  if (id === "notifications" && s.alertEmailAdmins && emailStatus(env, s) === "ready")
    return { text: "Email", tone: "ok" };
  return null;
}

function SettingsNav(props: { active: SettingsTab; env: Env; s: InstanceSettings }) {
  return (
    <nav class="settings-nav" aria-label="Settings sections">
      {SETTINGS_TABS.map((t) => {
        const badge = badgeFor(t.id, props.env, props.s);
        return (
          <a
            key={t.id}
            href={tabHref(t.id)}
            class={props.active === t.id ? "nav-link active" : "nav-link"}
            {...(props.active === t.id ? { "aria-current": "page" } : {})}
          >
            <Icon name={t.icon} />
            <span>{t.label}</span>
            {badge ? (
              <span class={`badge sm ${badge.tone} ${badge.tone ? "dot" : ""}`}>{badge.text}</span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

export async function settingsPage(c: ACtx, tab: SettingsTab, children: unknown) {
  const def = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];
  const s = await getInstanceSettings(c.env.DB);
  return page(
    c,
    {
      active: "settings",
      title: `${def?.label ?? "Settings"} · Settings`,
      crumbs: [{ label: "Settings", href: "/admin/settings" }, { label: def?.label ?? "" }],
    },
    <>
      <PageHead
        title="Settings"
        lede="Instance-wide settings. Changes take effect within seconds."
      />
      <div class="settings-layout">
        <SettingsNav active={tab} env={c.env} s={s} />
        <div class="stack-lg settings-main">
          <div class="settings-intro">
            <h2>{def?.label}</h2>
            <p class="muted">{def?.lede}</p>
          </div>
          {children}
        </div>
      </div>
    </>,
  );
}

export function SettingsCard(props: {
  icon: IconName;
  title: string;
  sub?: unknown;
  badge?: unknown;
  id?: string;
  children: unknown;
}) {
  return (
    <section class="card" {...(props.id ? { id: props.id } : {})}>
      <div class="card-head">
        <Icon name={props.icon} />
        <div class="grow">
          <h2>{props.title}</h2>
          {props.sub ? <div class="sub">{props.sub}</div> : null}
        </div>
        {props.badge ?? null}
      </div>
      {props.children}
    </section>
  );
}

export function SaveFoot(props: { label?: string }) {
  return (
    <div class="card-foot">
      <button class="btn primary right" type="submit">
        {props.label ?? "Save"}
      </button>
    </div>
  );
}

export function ChoiceList<T extends string>(props: {
  name: string;
  value: T;
  options: { value: T; label: string; sub?: string; warn?: boolean }[];
}) {
  return (
    <div class="choices" role="radiogroup">
      {props.options.map((o) => (
        <label key={o.value} class={o.warn ? "choice warn" : "choice"}>
          <input type="radio" name={props.name} value={o.value} checked={props.value === o.value} />
          <span>
            <b>{o.label}</b>
            {o.sub ? <span class="sub">{o.sub}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}
