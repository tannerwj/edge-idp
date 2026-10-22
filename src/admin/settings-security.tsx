import type { SignInUv, StepUpWindow } from "../settings-cache";
import { Icon } from "../ui/icons";

const WINDOWS: { value: StepUpWindow; label: string }[] = [
  { value: "5", label: "Within the last 5 minutes (recommended)" },
  { value: "15", label: "Within the last 15 minutes" },
  { value: "60", label: "Within the last hour" },
  { value: "off", label: "Never ask" },
];

export function SecurityCard(props: { adminStepUp: StepUpWindow; signInUv: SignInUv }) {
  return (
    <form class="card" id="security" method="post" action="/admin/settings/security">
      <div class="card-head">
        <Icon name="shield" />
        <div class="grow">
          <h2>Security</h2>
          <div class="sub">
            Changing these asks you to confirm with your passkey unless the recheck is off.
          </div>
        </div>
      </div>
      <div class="card-body stack">
        <label class="field">
          <span class="label">Passkey recheck for sensitive admin actions</span>
          <select name="adminStepUp">
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value} selected={props.adminStepUp === w.value}>
                {w.label}
              </option>
            ))}
          </select>
          <span class="hint">
            Inviting people, enrollment links, passkey resets, roles, emails, API tokens, OAuth
            clients, these settings and admin MCP sign-ins. Without a recheck, anyone holding a
            stolen admin session can do all of these, and with sign-in verification off as well, so
            can anyone holding an admin's unlocked device.
          </span>
        </label>
        <label class="switch">
          <input
            type="checkbox"
            name="signInUv"
            value="discouraged"
            checked={props.signInUv === "discouraged"}
          />
          <span class="track"></span>
          <span>
            Sign in without Face ID, Touch ID or a PIN
            <span class="sub">
              Asks passkeys to skip the biometric or PIN at sign-in; some providers (Apple) still
              ask. A found or stolen unlocked device or security key is then enough to sign in.
              Rechecks and new passkeys always verify.
            </span>
          </span>
        </label>
      </div>
      <div class="card-foot">
        <button class="btn primary right" type="submit">
          Save security settings
        </button>
      </div>
    </form>
  );
}
