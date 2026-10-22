import { Hono } from "hono";
import { getInstanceSettings } from "../../settings-cache";
import { emailStatus, sendMail } from "../../email";
import type { EmailStatus } from "../../email";
import type { AdminVars } from "../shell";
import { act, actor, field } from "../shell";
import * as ops from "../../ops";
import { Callout } from "../../ui/components";
import { Icon } from "../../ui/icons";
import { SaveFoot, SettingsCard, settingsPage } from "./shell";

export const emailSettings = new Hono<AdminVars>();

const STATUS: Record<EmailStatus, { text: string; tone: string }> = {
  ready: { text: "Sending", tone: "ok" },
  off: { text: "Off", tone: "" },
  "no-binding": { text: "Not set up", tone: "" },
  "no-sender": { text: "Needs a sender", tone: "warn" },
};

function SetupSteps() {
  return (
    <Callout icon="info">
      <p>
        This Worker has no <code>EMAIL</code> binding yet. To send email:
      </p>
      <ol class="stack-sm small">
        <li>
          In the Cloudflare dashboard, open <b>Compute → Email Service → Email Sending</b> and
          onboard the domain you'll send from (it must use Cloudflare DNS). Sending to any address
          needs the Workers Paid plan.
        </li>
        <li>
          Add a <code>send_email</code> binding named <code>EMAIL</code> to the Worker config and
          redeploy (DEPLOY.md › Email).
        </li>
        <li>Come back here, choose the sender address and send yourself a test.</li>
      </ol>
    </Callout>
  );
}

emailSettings.get("/email", async (c) => {
  const s = await getInstanceSettings(c.env.DB);
  const status = emailStatus(c.env, s);
  const badge = STATUS[status];
  const me = c.get("admin");
  return settingsPage(
    c,
    "email",
    <>
      <SettingsCard
        icon="mail"
        title="Sending"
        sub="Email is used for invites, sign-in links, account recovery and security notices. With it off, everything still works: links are shown to admins to share themselves."
        badge={<span class={`badge ${badge.tone} ${badge.tone ? "dot" : ""}`}>{badge.text}</span>}
      >
        {status === "no-binding" ? (
          <div class="card-body">
            <SetupSteps />
          </div>
        ) : (
          <form method="post" action="/admin/settings/email">
            <div class="card-body stack">
              <label class="switch">
                <input type="checkbox" name="enabled" value="1" checked={s.emailEnabled} />
                <span class="track"></span>
                <span>
                  Send email
                  <span class="sub">Turn off to stop all email without losing the settings.</span>
                </span>
              </label>
              <div class="grid-2">
                <label class="field">
                  <span class="label">Sender address</span>
                  <input
                    name="from"
                    type="email"
                    value={s.emailFrom ?? ""}
                    placeholder="id@yourdomain.com"
                    autocomplete="off"
                    required
                  />
                  <span class="hint">Must be on a domain onboarded to Email Service.</span>
                </label>
                <label class="field">
                  <span class="label">Sender name</span>
                  <input
                    name="fromName"
                    value={s.emailFromName ?? ""}
                    placeholder={c.env.RP_NAME}
                    maxLength={60}
                    autocomplete="off"
                  />
                  <span class="hint">Defaults to the instance name.</span>
                </label>
              </div>
            </div>
            <SaveFoot />
          </form>
        )}
      </SettingsCard>
      {status === "ready" ? (
        <SettingsCard
          icon="send"
          title="Test"
          sub={`Sends a short message to ${me.public ? "your account" : me.email}.`}
        >
          <form method="post" action="/admin/settings/email/test" class="card-body">
            <button class="btn" type="submit">
              <Icon name="send" size="sm" />
              <span>Send a test email</span>
            </button>
          </form>
        </SettingsCard>
      ) : null}
    </>,
  );
});

emailSettings.post("/email", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/email", "Email settings saved", () =>
    ops.setEmailSettings(
      c.env.DB,
      {
        enabled: field(form, "enabled") === "1",
        from: field(form, "from"),
        fromName: field(form, "fromName"),
      },
      actor(c),
    ),
  );
});

emailSettings.post("/email/test", async (c) => {
  const s = await getInstanceSettings(c.env.DB);
  const me = c.get("admin");
  return act(c, "/admin/settings/email", `Test email sent to ${me.email}`, async () => {
    const r = await sendMail(c.env, s, me.email, {
      subject: `Test email from ${c.env.RP_NAME}`,
      heading: "Email works",
      paragraphs: [
        `${c.env.RP_NAME} can send email from ${s.emailFrom ?? "this address"}. Invites, sign-in links and security notices will arrive like this one.`,
      ],
      footer: "You're receiving this because you sent a test from Settings › Email.",
    });
    if (!r.ok)
      throw new ops.OpError(
        `Cloudflare refused the message: ${r.error}. Until the sender's domain is onboarded to Email Service, Cloudflare only delivers to verified addresses.`,
      );
  });
});
