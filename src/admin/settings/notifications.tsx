import { Hono } from "hono";
import { getInstanceSettings } from "../../settings-cache";
import { emailStatus } from "../../email";
import { ALERT_GROUPS, listWebhooks, WEBHOOK_FORMATS } from "../../notify";
import type { Webhook } from "../../notify";
import { addWebhook, deleteWebhook, setAlerts, testWebhook } from "../../ops-notify";
import { eventMeta } from "../../ui/feed";
import type { AdminVars } from "../shell";
import { act, actor, field, fields } from "../shell";
import { Callout, CopyField, PostButton, Time } from "../../ui/components";
import { SaveFoot, SettingsCard, settingsPage } from "./shell";

export const notificationSettings = new Hono<AdminVars>();

const FORMAT_LABEL: Record<string, string> = {
  json: "JSON (signed if you add a secret)",
  discord: "Discord",
  slack: "Slack",
  ntfy: "ntfy",
};

function AlertsCard(props: {
  events: string[];
  emailAdmins: boolean;
  notices: boolean;
  mail: boolean;
}) {
  const on = new Set(props.events);
  return (
    <form method="post" action="/admin/settings/notifications/alerts" class="stack-lg">
      <SettingsCard
        icon="bell"
        title="Admin alerts"
        sub="Which events reach admins by email and every webhook below. Everything is always in the audit log."
      >
        <div class="card-body stack">
          {ALERT_GROUPS.map((g) => (
            <fieldset key={g.label} class="field">
              <legend class="label">{g.label}</legend>
              <div class="chips">
                {g.events.map((e) => (
                  <label key={e} class="chip-toggle">
                    <input type="checkbox" name="events" value={e} checked={on.has(e)} />
                    <span>{eventMeta(e).label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <label class="switch">
            <input type="checkbox" name="emailAdmins" value="1" checked={props.emailAdmins} />
            <span class="track"></span>
            <span>
              Email every admin
              <span class="sub">
                {props.mail
                  ? "Sends each chosen event to every admin."
                  : "Needs email (Settings › Email)."}
              </span>
            </span>
          </label>
        </div>
      </SettingsCard>
      <SettingsCard
        icon="user"
        title="Security notices to people"
        sub="An email to the person concerned when a passkey is added or removed, their passkeys are reset, they become an admin, or they sign in with an email link."
      >
        <div class="card-body">
          <label class="switch">
            <input type="checkbox" name="userNotices" value="1" checked={props.notices} />
            <span class="track"></span>
            <span>
              Send security notices
              <span class="sub">
                {props.mail
                  ? "Recommended: people notice changes they didn't make."
                  : "Needs email."}
              </span>
            </span>
          </label>
        </div>
        <SaveFoot />
      </SettingsCard>
    </form>
  );
}

function WebhookRow({ h }: { h: Webhook }) {
  const ok = h.last_status ? /^2\d\d$/.test(h.last_status) : null;
  return (
    <li class="stack-sm">
      <div class="row">
        <div class="grow truncate">
          <b>{h.name}</b> <span class="badge">{FORMAT_LABEL[h.format]?.split(" ")[0]}</span>
          <div class="sub truncate mono small">{h.url}</div>
          <div class="sub small">
            {h.last_at ? (
              <>
                Last delivery <Time ts={h.last_at} />:{" "}
                <span class={ok ? "badge ok" : "badge bad"}>{h.last_status}</span>
              </>
            ) : (
              "Nothing sent yet"
            )}
          </div>
        </div>
        <PostButton
          action={`/admin/settings/notifications/webhooks/${h.id}/test`}
          label="Send test"
          icon="send"
        />
        <PostButton
          action={`/admin/settings/notifications/webhooks/${h.id}/delete`}
          label="Remove"
          class="btn sm ghost danger"
          confirm={`Remove the ${h.name} webhook?`}
        />
      </div>
      {h.secret ? <CopyField value={h.secret} mask label="signing secret" /> : null}
    </li>
  );
}

function WebhooksCard({ hooks }: { hooks: Webhook[] }) {
  return (
    <SettingsCard
      icon="zap"
      title="Webhooks"
      sub="Posts each chosen event to a URL: a Discord or Slack channel, an ntfy topic, or your own endpoint. https only; redirects aren't followed."
    >
      {hooks.length ? (
        <ul class="list card-body">
          {hooks.map((h) => (
            <WebhookRow key={h.id} h={h} />
          ))}
        </ul>
      ) : null}
      <form method="post" action="/admin/settings/notifications/webhooks" class="card-body stack">
        <div class="grid-2">
          <label class="field">
            <span class="label">Name</span>
            <input name="name" maxLength={60} placeholder="Family Discord" required />
          </label>
          <label class="field">
            <span class="label">Format</span>
            <select name="format">
              {WEBHOOK_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label class="field">
          <span class="label">URL</span>
          <input name="url" type="url" required placeholder="https://discord.com/api/webhooks/…" />
        </label>
        <label class="check">
          <input type="checkbox" name="sign" value="1" />
          <span>
            Sign requests
            <span class="sub">
              Adds an <code>x-edge-idp-signature: sha256=…</code> HMAC of the body, so your endpoint
              can check it came from here.
            </span>
          </span>
        </label>
        <div class="row-sm">
          <button class="btn" type="submit">
            Add webhook
          </button>
        </div>
      </form>
    </SettingsCard>
  );
}

notificationSettings.get("/notifications", async (c) => {
  const [s, hooks] = await Promise.all([getInstanceSettings(c.env.DB), listWebhooks(c.env.DB)]);
  const mail = emailStatus(c.env, s) === "ready";
  return settingsPage(
    c,
    "notifications",
    <>
      {mail ? null : (
        <Callout>
          Email isn't sending yet, so alerts go to webhooks only. Set it up in Settings › Email.
        </Callout>
      )}
      <AlertsCard
        events={s.alertEvents}
        emailAdmins={s.alertEmailAdmins}
        notices={s.userNotices}
        mail={mail}
      />
      <WebhooksCard hooks={hooks} />
    </>,
  );
});

notificationSettings.post("/notifications/alerts", async (c) => {
  const form = await c.req.parseBody({ all: true });
  return act(c, "/admin/settings/notifications", "Notifications saved", () =>
    setAlerts(
      c.env.DB,
      {
        events: fields(form, "events"),
        emailAdmins: field(form, "emailAdmins") === "1",
        userNotices: field(form, "userNotices") === "1",
      },
      actor(c),
    ),
  );
});

notificationSettings.post("/notifications/webhooks", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/notifications", "Webhook added — send it a test", () =>
    addWebhook(
      c.env,
      {
        name: field(form, "name"),
        url: field(form, "url"),
        format: field(form, "format"),
        sign: field(form, "sign") === "1",
      },
      actor(c),
    ),
  );
});

notificationSettings.post("/notifications/webhooks/:id/test", async (c) =>
  act(c, "/admin/settings/notifications", "Test delivered", () =>
    testWebhook(c.env, c.req.param("id"), actor(c)),
  ),
);

notificationSettings.post("/notifications/webhooks/:id/delete", async (c) =>
  act(c, "/admin/settings/notifications", "Webhook removed", () =>
    deleteWebhook(c.env.DB, c.req.param("id"), actor(c)),
  ),
);
