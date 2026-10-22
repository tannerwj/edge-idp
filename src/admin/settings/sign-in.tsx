import { Hono } from "hono";
import { getInstanceSettings, RECOVERY_MODES, SETTING_KEYS } from "../../settings-cache";
import type { RecoveryMode, SignInUv, StepUpWindow } from "../../settings-cache";
import { emailStatus } from "../../email";
import type { AdminVars } from "../shell";
import { act, actor, field } from "../shell";
import * as ops from "../../ops";
import { Callout } from "../../ui/components";
import { ChoiceList, SaveFoot, SettingsCard, settingsPage } from "./shell";

export const signInSettings = new Hono<AdminVars>();

const WINDOWS: { value: StepUpWindow; label: string; sub?: string; warn?: boolean }[] = [
  { value: "5", label: "Within the last 5 minutes", sub: "Recommended." },
  { value: "15", label: "Within the last 15 minutes" },
  { value: "60", label: "Within the last hour" },
  {
    value: "off",
    label: "Never ask",
    sub: "Anyone holding a stolen admin session can do all of these.",
    warn: true,
  },
];

const UV: { value: SignInUv; label: string; sub: string; warn?: boolean }[] = [
  {
    value: "required",
    label: "Always",
    sub: "Face ID, Touch ID, Windows Hello or the security key's PIN every time. Recommended.",
  },
  {
    value: "discouraged",
    label: "Only when the device insists",
    sub: "Asks passkeys to skip the check at sign-in (Apple's usually still ask). An unlocked device or a found security key is then enough to sign in.",
    warn: true,
  },
];

const RECOVERY: { value: RecoveryMode; label: string; sub: string; warn?: boolean }[] = [
  {
    value: "off",
    label: "An admin handles it",
    sub: "No link on the sign-in page. People ask you directly, and you send them a new enrollment link.",
  },
  {
    value: "approval",
    label: "People ask, an admin approves",
    sub: 'Sign-in shows "Lost your passkey?". Requests appear on the Overview and in admin alerts; approving sends a one-hour link.',
  },
  {
    value: "auto",
    label: "Email them a link right away",
    sub: "Needs email. Anyone who can read a member's inbox can add a passkey to their account. Admins' requests still need another admin.",
    warn: true,
  },
];

function EmailLinksCard(props: { on: boolean; emailReady: boolean }) {
  return (
    <form method="post" action="/admin/settings/sign-in/email-links">
      <SettingsCard
        icon="send"
        title="Email sign-in links"
        sub="Lets members without a passkey on this device sign in with a one-time link sent to their email. Admins and public accounts never can."
        badge={props.on ? <span class="badge warn dot">On</span> : <span class="badge">Off</span>}
      >
        <div class="card-body stack">
          <label class="switch">
            <input type="checkbox" name="magicLinks" value="1" checked={props.on} />
            <span class="track"></span>
            <span>
              Offer "Email me a sign-in link"
              <span class="sub">
                Convenient for family who struggle with passkeys, but it makes each member's inbox a
                way into every app they can use, and email links can be phished where passkeys
                can't. Apps see these sign-ins as <code>amr: ["otp"]</code>; require a passkey for
                sensitive apps on their client page.
              </span>
            </span>
          </label>
          {props.emailReady ? null : (
            <Callout>Needs email (Settings › Email); until then the option stays hidden.</Callout>
          )}
        </div>
        <SaveFoot />
      </SettingsCard>
    </form>
  );
}

function RecoveryCard(props: { mode: RecoveryMode; emailReady: boolean }) {
  return (
    <form method="post" action="/admin/settings/sign-in/recovery">
      <SettingsCard
        icon="key"
        title="Lost passkeys"
        sub="What happens when someone can't sign in because their passkeys are gone."
      >
        <div class="card-body stack">
          <ChoiceList name="recoveryMode" value={props.mode} options={RECOVERY} />
          {props.mode === "auto" && !props.emailReady ? (
            <Callout tone="warn">
              Email isn't sending, so requests wait for an admin until it is.
            </Callout>
          ) : null}
        </div>
        <SaveFoot />
      </SettingsCard>
    </form>
  );
}

signInSettings.get("/sign-in", async (c) => {
  const s = await getInstanceSettings(c.env.DB);
  return settingsPage(
    c,
    "sign-in",
    <>
      <form method="post" action="/admin/settings/sign-in" class="stack-lg">
        <SettingsCard
          icon="fingerprint"
          title="Verify the person at sign-in"
          sub="Whether a passkey sign-in also needs the device's biometric or PIN. Passkey rechecks and new passkeys always need it."
        >
          <div class="card-body">
            <ChoiceList name="signInUv" value={s.signInUv} options={UV} />
            <label class="check">
              <input
                type="checkbox"
                name="adminsAlwaysVerify"
                value="1"
                checked={s.adminsAlwaysVerify}
              />
              <span>
                Admins always verify
                <span class="sub">
                  Even when sign-in doesn't ask for it, an admin's sign-in is refused without the
                  biometric or PIN, and they're asked again.
                </span>
              </span>
            </label>
          </div>
        </SettingsCard>
        <SettingsCard
          icon="shield"
          title="Recheck before sensitive admin actions"
          sub="Inviting people, enrollment links, passkey resets, roles, emails, API tokens, OAuth clients, settings and admin MCP sign-ins ask the admin to use their passkey again if they haven't recently."
        >
          <div class="card-body">
            <ChoiceList name="adminStepUp" value={s.adminStepUp} options={WINDOWS} />
            {s.adminStepUp === "off" && s.signInUv === "discouraged" ? (
              <Callout tone="warn">
                With both relaxed, anyone holding an admin's unlocked device can do everything an
                admin can.
              </Callout>
            ) : null}
          </div>
          <SaveFoot />
        </SettingsCard>
      </form>
      <EmailLinksCard on={s.magicLinks} emailReady={emailStatus(c.env, s) === "ready"} />
      <RecoveryCard mode={s.recoveryMode} emailReady={emailStatus(c.env, s) === "ready"} />
    </>,
  );
});

signInSettings.post("/sign-in/email-links", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/sign-in", "Saved", () =>
    ops.setFlagSetting(
      c.env.DB,
      SETTING_KEYS.magicLinks,
      field(form, "magicLinks") === "1",
      actor(c),
      "SECURITY_SETTINGS_CHANGED",
    ),
  );
});

signInSettings.post("/sign-in/recovery", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/sign-in", "Saved", () =>
    ops.setChoiceSetting(
      c.env.DB,
      SETTING_KEYS.recoveryMode,
      field(form, "recoveryMode"),
      RECOVERY_MODES,
      actor(c),
    ),
  );
});

signInSettings.post("/sign-in", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/sign-in", "Sign-in settings saved", () =>
    ops.setSecuritySettings(
      c.env.DB,
      {
        adminStepUp: field(form, "adminStepUp"),
        signInUv: field(form, "signInUv"),
        adminsAlwaysVerify: field(form, "adminsAlwaysVerify") === "1",
      },
      actor(c),
    ),
  );
});
