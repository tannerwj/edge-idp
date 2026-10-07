import { Icon } from "./icons";
import type { IconName } from "./icons";
import { Time } from "./components";

type Tone = "ok" | "warn" | "bad" | "accent" | "";

const EVENTS: Record<string, { label: string; icon: IconName; tone: Tone }> = {
  SIGN_IN: { label: "Signed in", icon: "logIn", tone: "ok" },
  SIGN_OUT: { label: "Signed out", icon: "logOut", tone: "" },
  PASSKEY_REGISTERED: { label: "Added a passkey", icon: "fingerprint", tone: "accent" },
  PASSKEY_REMOVED: { label: "Removed a passkey", icon: "fingerprint", tone: "warn" },
  PASSKEY_RENAMED: { label: "Renamed a passkey", icon: "fingerprint", tone: "" },
  PASSKEYS_REVOKED: { label: "Passkeys reset", icon: "fingerprint", tone: "bad" },
  PASSKEY_COUNTER_REGRESSION: { label: "Possible cloned passkey", icon: "alert", tone: "bad" },
  SETUP_COMPLETED: { label: "First admin created (setup)", icon: "sparkles", tone: "accent" },
  SETUP_REJECTED: { label: "Wrong setup token", icon: "alert", tone: "bad" },
  USER_CREATED: { label: "User created", icon: "userPlus", tone: "accent" },
  USER_DELETED: { label: "User deleted", icon: "trash", tone: "bad" },
  USER_DISABLED: { label: "User disabled", icon: "ban", tone: "bad" },
  USER_ENABLED: { label: "User enabled", icon: "check", tone: "ok" },
  USER_PROFILE_UPDATED: { label: "Profile updated", icon: "edit", tone: "" },
  PROFILE_UPDATED: { label: "Profile updated", icon: "edit", tone: "" },
  USER_GROUPS_UPDATED: { label: "Groups changed", icon: "group", tone: "" },
  ADMIN_GRANTED: { label: "Made admin", icon: "shield", tone: "warn" },
  ADMIN_REVOKED: { label: "Admin removed", icon: "shield", tone: "" },
  ENROLLMENT_STARTED: { label: "Enrollment link issued", icon: "link", tone: "" },
  SESSION_REVOKED: { label: "Sessions revoked", icon: "logOut", tone: "warn" },
  GROUP_CREATED: { label: "Group created", icon: "group", tone: "accent" },
  GROUP_UPDATED: { label: "Group updated", icon: "group", tone: "" },
  GROUP_DELETED: { label: "Group deleted", icon: "trash", tone: "warn" },
  GROUP_MEMBER_ADDED: { label: "Added to group", icon: "group", tone: "" },
  GROUP_MEMBER_REMOVED: { label: "Removed from group", icon: "group", tone: "" },
  CLIENT_CREATED: { label: "Client registered", icon: "plug", tone: "accent" },
  CLIENT_REGISTERED: { label: "Client self-registered", icon: "plug", tone: "accent" },
  CLIENT_DISCOVERED: { label: "Client discovered (CIMD)", icon: "plug", tone: "accent" },
  CLIENT_UPDATED: { label: "Client updated", icon: "plug", tone: "" },
  CLIENT_DELETED: { label: "Client deleted", icon: "trash", tone: "warn" },
  CLIENT_SECRET_ROTATED: { label: "Client secret rotated", icon: "refresh", tone: "warn" },
  CODE_ISSUED: { label: "Authorized an app", icon: "arrowUpRight", tone: "" },
  CODE_REJECTED: { label: "Rejected an auth code", icon: "alert", tone: "warn" },
  TOKEN_ISSUED: { label: "Tokens issued", icon: "key", tone: "" },
  ACCESS_DENIED: { label: "Access denied", icon: "ban", tone: "bad" },
  CONSENT_GRANTED: { label: "Approved an app", icon: "check", tone: "accent" },
  CONSENT_DENIED: { label: "Declined an app", icon: "x", tone: "" },
  CONSENT_REVOKED: { label: "Disconnected an app", icon: "x", tone: "warn" },
  REFRESH_REUSE_DETECTED: { label: "Refresh token replay blocked", icon: "alert", tone: "bad" },
  API_TOKEN_CREATED: { label: "API token created", icon: "key", tone: "accent" },
  API_TOKEN_REVOKED: { label: "API token revoked", icon: "key", tone: "warn" },
  APP_CREATED: { label: "App added", icon: "grid", tone: "accent" },
  APP_UPDATED: { label: "App updated", icon: "grid", tone: "" },
  APP_DELETED: { label: "App removed", icon: "trash", tone: "warn" },
  SETTINGS_CHANGED: { label: "Settings changed", icon: "settings", tone: "" },
  CF_API_CONNECTED: { label: "Cloudflare connected", icon: "cloud", tone: "warn" },
  CF_API_DISCONNECTED: { label: "Cloudflare disconnected", icon: "cloud", tone: "" },
  THEME_CHANGED: { label: "Theme changed", icon: "settings", tone: "" },
  CLIENT_PKCE_TOGGLED: { label: "PKCE setting changed", icon: "plug", tone: "" },
};

export function eventMeta(event: string): { label: string; icon: IconName; tone: Tone } {
  return (
    EVENTS[event] ?? { label: event.toLowerCase().replace(/_/g, " "), icon: "activity", tone: "" }
  );
}

export interface FeedRow {
  event: string;
  created_at: number;
  email?: string | null;
  name?: string | null;
  client_name?: string | null;
}

export function Feed(props: { rows: FeedRow[]; showWho?: boolean }) {
  return (
    <ul class="feed">
      {props.rows.map((r, i) => {
        const m = eventMeta(r.event);
        return (
          <li key={`${r.event}-${r.created_at}-${String(i)}`}>
            <span class={`ev-icon ${m.tone}`}>
              <Icon name={m.icon} size="sm" />
            </span>
            <div class="what">
              <div class="t truncate">
                {props.showWho !== false && (r.name || r.email) ? (
                  <b>{r.name ?? r.email} </b>
                ) : null}
                <span class={props.showWho !== false && (r.name || r.email) ? "text-2" : ""}>
                  {props.showWho !== false && (r.name || r.email)
                    ? m.label.charAt(0).toLowerCase() + m.label.slice(1)
                    : m.label}
                </span>
                {r.client_name ? <span class="muted"> · {r.client_name}</span> : null}
              </div>
            </div>
            <span class="when">
              <Time ts={r.created_at} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function deviceLabel(ua: string | null | undefined): { label: string; icon: IconName } {
  if (!ua) return { label: "Unknown device", icon: "monitor" };
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  if (/iPhone/.test(ua)) return { label: `${browser} on iPhone`, icon: "phone" };
  if (/iPad/.test(ua)) return { label: `${browser} on iPad`, icon: "phone" };
  if (/Android/.test(ua)) return { label: `${browser} on Android`, icon: "phone" };
  if (/Mac OS X|Macintosh/.test(ua)) return { label: `${browser} on Mac`, icon: "laptop" };
  if (/Windows/.test(ua)) return { label: `${browser} on Windows`, icon: "laptop" };
  if (/Linux/.test(ua)) return { label: `${browser} on Linux`, icon: "laptop" };
  return { label: browser, icon: "monitor" };
}
