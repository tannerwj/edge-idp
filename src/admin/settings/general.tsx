import { Hono } from "hono";
import { audit, setSetting } from "../../db";
import {
  ACCENTS,
  getInstanceSettings,
  invalidateSettingsCache,
  SETTING_KEYS,
} from "../../settings-cache";
import type { AdminVars } from "../shell";
import { act, actor, field } from "../shell";
import * as ops from "../../ops";
import { SaveFoot, SettingsCard, settingsPage } from "./shell";

export const generalSettings = new Hono<AdminVars>();

generalSettings.get("/", async (c) => {
  const s = await getInstanceSettings(c.env.DB);
  return settingsPage(
    c,
    "general",
    <form method="post" action="/admin/settings" class="stack-lg">
      <SettingsCard
        icon="fingerprint"
        title="Name"
        sub="Shown on sign-in pages, invites and emails, and used by password managers to label new passkeys. Existing passkeys keep the label they were saved with."
      >
        <div class="card-body">
          <label class="field">
            <span class="label">Instance name</span>
            <input
              name="name"
              value={s.name || c.env.RP_NAME}
              required
              maxLength={60}
              autocomplete="off"
            />
          </label>
        </div>
      </SettingsCard>
      <SettingsCard
        icon="sparkles"
        title="Appearance"
        sub="Accent color for everyone. Light and dark follow each person's device, or the toggle in the sidebar."
      >
        <div class="card-body">
          <div class="swatches">
            {ACCENTS.map((a) => (
              <label key={a} class="swatch" data-accent={a} title={a}>
                <input type="radio" name="accent" value={a} checked={s.accent === a} />
                <span></span>
              </label>
            ))}
          </div>
        </div>
        <SaveFoot />
      </SettingsCard>
    </form>,
  );
});

generalSettings.post("/", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings", "Settings saved", async () => {
    const name = field(form, "name");
    if (name !== c.env.RP_NAME) await ops.setInstanceName(c.env.DB, name, actor(c));
    const accent = field(form, "accent");
    if ((ACCENTS as readonly string[]).includes(accent))
      await setSetting(c.env.DB, SETTING_KEYS.accent, accent);
    invalidateSettingsCache();
    await audit(c.env.DB, "SETTINGS_CHANGED", { userId: c.get("admin").id, detail: { accent } });
  });
});
