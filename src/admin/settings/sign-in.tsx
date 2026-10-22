import { Hono } from "hono";
import { getInstanceSettings } from "../../settings-cache";
import type { SignInUv, StepUpWindow } from "../../settings-cache";
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

signInSettings.get("/sign-in", async (c) => {
  const s = await getInstanceSettings(c.env.DB);
  return settingsPage(
    c,
    "sign-in",
    <form method="post" action="/admin/settings/sign-in" class="stack-lg">
      <SettingsCard
        icon="fingerprint"
        title="Verify the person at sign-in"
        sub="Whether a passkey sign-in also needs the device's biometric or PIN. Passkey rechecks and new passkeys always need it."
      >
        <div class="card-body">
          <ChoiceList name="signInUv" value={s.signInUv} options={UV} />
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
    </form>,
  );
});

signInSettings.post("/sign-in", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/sign-in", "Sign-in settings saved", () =>
    ops.setSecuritySettings(
      c.env.DB,
      { adminStepUp: field(form, "adminStepUp"), signInUv: field(form, "signInUv") },
      actor(c),
    ),
  );
});
