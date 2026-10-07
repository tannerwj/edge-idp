/** Shared server-rendered UI components (no behavior; app.js wires data-*). */
import { Icon } from "./icons";
import type { IconName } from "./icons";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
  return (a + b).toUpperCase();
}

/** Stable 0–11 hue bucket from any string. */
export function hueOf(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return String(h % 12);
}

export function Avatar(props: { name: string; seed?: string; size?: "sm" | "lg" }) {
  return (
    <span class={props.size ? `avatar ${props.size}` : "avatar"} data-hue={hueOf(props.seed ?? props.name)} aria-hidden="true">
      {initials(props.name)}
    </span>
  );
}

/** Timestamp rendered relative in the viewer's locale by app.js. */
export function Time(props: { ts: number | null | undefined; empty?: string; abs?: boolean }) {
  if (!props.ts) return <span class="muted">{props.empty ?? "—"}</span>;
  const iso = new Date(props.ts * 1000).toISOString();
  return (
    <time datetime={iso} data-time={props.abs ? "abs" : "rel"} title={iso}>
      {iso.slice(0, 16).replace("T", " ")} UTC
    </time>
  );
}

export function PageHead(props: { title: string; lede?: unknown; actions?: unknown; leading?: unknown }) {
  return (
    <div class="page-head">
      {props.leading}
      <div class="grow">
        <h1>{props.title}</h1>
        {props.lede ? <p class="lede">{props.lede}</p> : null}
      </div>
      {props.actions ? <div class="actions">{props.actions}</div> : null}
    </div>
  );
}

export function Empty(props: { icon: IconName; title: string; children?: unknown; action?: unknown }) {
  return (
    <div class="empty">
      <div class="art">
        <Icon name={props.icon} size="lg" />
      </div>
      <h3>{props.title}</h3>
      {props.children ? <p>{props.children}</p> : null}
      {props.action ? <div class="row empty-action">{props.action}</div> : null}
    </div>
  );
}

export function CopyField(props: { value: string; big?: boolean; mask?: boolean; label?: string }) {
  return (
    <div class={props.big ? "secret big" : "secret"}>
      <span class="val" data-copy-source>
        {props.value}
      </span>
      <button class="btn sm copy-btn" type="button" data-copy={props.value} aria-label={`Copy ${props.label ?? ""}`.trim()}>
        <Icon name="copy" size="sm" />
        <span>Copy</span>
      </button>
    </div>
  );
}

export function Callout(props: { tone?: "accent" | "warn" | "bad" | "ok"; icon?: IconName; children: unknown }) {
  return (
    <div class={props.tone ? `callout ${props.tone}` : "callout"}>
      <Icon name={props.icon ?? (props.tone === "warn" || props.tone === "bad" ? "alert" : "info")} />
      <div class="grow">{props.children}</div>
    </div>
  );
}

/** Modal (or side sheet) opened by any element with data-open="<id>". */
export function Dialog(props: {
  id: string;
  title: string;
  lede?: unknown;
  sheet?: boolean;
  action?: string;
  submit?: string;
  danger?: boolean;
  children: unknown;
}) {
  const body = (
    <>
      <div class="dlg-head">
        <div class="grow">
          <h2>{props.title}</h2>
          {props.lede ? <p>{props.lede}</p> : null}
        </div>
        <button class="btn ghost icon sm" type="button" data-close aria-label="Close">
          <Icon name="x" size="sm" />
        </button>
      </div>
      <div class="dlg-body">{props.children}</div>
      {props.action ? (
        <div class="dlg-foot">
          <button class="btn" type="button" data-close>
            Cancel
          </button>
          <button class={props.danger ? "btn danger solid" : "btn primary"} type="submit">
            {props.submit ?? "Save"}
          </button>
        </div>
      ) : null}
    </>
  );
  return (
    <dialog id={props.id} class={props.sheet ? "sheet" : ""} aria-labelledby={`${props.id}-t`}>
      {props.action ? (
        <form method="post" action={props.action}>
          {body}
        </form>
      ) : (
        body
      )}
    </dialog>
  );
}

/** A POST button (optionally confirmed) — every mutation is a form. */
export function PostButton(props: {
  action: string;
  label: string;
  icon?: IconName;
  class?: string;
  confirm?: string;
  fields?: Record<string, string>;
  title?: string;
}) {
  return (
    <form method="post" action={props.action} class="inline-form" {...(props.confirm ? { "data-confirm": props.confirm } : {})}>
      {Object.entries(props.fields ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button class={props.class ?? "btn sm"} type="submit" title={props.title}>
        {props.icon ? <Icon name={props.icon} size="sm" /> : null}
        {props.label ? <span>{props.label}</span> : null}
      </button>
    </form>
  );
}

export function GroupChips(props: { groups: string[] | null | undefined; empty?: string }) {
  if (!props.groups?.length) return <span class="muted small">{props.empty ?? "Everyone"}</span>;
  return (
    <span class="chips">
      {props.groups.map((g) => (
        <span key={g} class="badge">{g}</span>
      ))}
    </span>
  );
}

/** Multi-select group picker as toggle chips. */
export function GroupPicker(props: { name: string; all: { name: string }[]; selected: string[] | null | undefined }) {
  if (!props.all.length) return <p class="muted small">No groups yet — create one under Groups.</p>;
  const sel = new Set(props.selected ?? []);
  return (
    <div class="chips">
      {props.all.map((g) => (
        <label key={g.name} class="chip-toggle">
          <input type="checkbox" name={props.name} value={g.name} checked={sel.has(g.name)} />
          <span>{g.name}</span>
        </label>
      ))}
    </div>
  );
}

