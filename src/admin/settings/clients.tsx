import { Hono } from "hono";
import { audit, setSetting } from "../../db";
import { getInstanceSettings, invalidateSettingsCache, SETTING_KEYS } from "../../settings-cache";
import type { AdminVars } from "../shell";
import { act, field } from "../shell";
import { SaveFoot, SettingsCard, settingsPage } from "./shell";

export const clientSettings = new Hono<AdminVars>();

function Toggle(props: { name: string; on: boolean; label: string; sub: string }) {
  return (
    <label class="switch">
      <input type="checkbox" name={props.name} value="1" checked={props.on} />
      <span class="track"></span>
      <span>
        {props.label}
        <span class="sub">{props.sub}</span>
      </span>
    </label>
  );
}

clientSettings.get("/clients", async (c) => {
  const s = await getInstanceSettings(c.env.DB);
  return settingsPage(
    c,
    "clients",
    <form method="post" action="/admin/settings/clients">
      <SettingsCard
        icon="bot"
        title="Self-registering clients"
        sub="Clients that register themselves always show a consent screen, and only admins can approve them until you give them groups."
      >
        <div class="card-body stack">
          <Toggle
            name="cimd"
            on={s.cimdEnabled}
            label="Client ID metadata documents"
            sub="Clients identified by an https URL they control (claude.ai, Claude Code, VS Code). Recommended."
          />
          <Toggle
            name="dcr"
            on={s.dcrEnabled}
            label="Dynamic client registration"
            sub="Anyone can register a client (Cursor needs this). Unused ones are removed after 30 days; at most 1,000 can wait at once."
          />
        </div>
        <SaveFoot />
      </SettingsCard>
    </form>,
  );
});

clientSettings.post("/clients", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/clients", "Client onboarding saved", async () => {
    const cimd = field(form, "cimd") === "1";
    const dcr = field(form, "dcr") === "1";
    await setSetting(c.env.DB, SETTING_KEYS.cimdEnabled, cimd ? "1" : "0");
    await setSetting(c.env.DB, SETTING_KEYS.dcrEnabled, dcr ? "1" : "0");
    invalidateSettingsCache();
    await audit(c.env.DB, "SETTINGS_CHANGED", {
      userId: c.get("admin").id,
      detail: { cimd, dcr },
    });
  });
});
