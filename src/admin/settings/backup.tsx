import { Hono } from "hono";
import { exportBackup, importBackup, MAX_BACKUP_BYTES, parseBackup } from "../../backup";
import type { AdminVars } from "../shell";
import { actor, failBack } from "../shell";
import { sha256Hex } from "../../util";
import { Callout } from "../../ui/components";
import { Icon } from "../../ui/icons";
import { OpError } from "../../ops-core";
import { SettingsCard, settingsPage } from "./shell";

export const backupSettings = new Hono<AdminVars>();

backupSettings.get("/backup", async (c) =>
  settingsPage(
    c,
    "backup",
    <>
      <SettingsCard
        icon="download"
        title="Download a backup"
        sub="People, their passkeys' public keys, groups, apps, grants, clients, webhooks and settings, as one JSON file."
      >
        <div class="card-body stack">
          <Callout tone="warn">
            Treat the file like a password: it holds everyone's email, client secret hashes and
            webhook URLs. It never includes sessions, tokens, signing keys, the audit log or the
            Cloudflare token.
          </Callout>
          <form method="post" action="/admin/settings/backup/export">
            <button class="btn" type="submit">
              <Icon name="download" size="sm" />
              <span>Download backup</span>
            </button>
          </form>
        </div>
      </SettingsCard>
      <SettingsCard
        icon="upload"
        title="Restore from a backup"
        sub="Brings an instance back from a backup file, or copies configuration into a new one."
      >
        <form
          method="post"
          action="/admin/settings/backup/preview"
          enctype="multipart/form-data"
          class="card-body stack"
        >
          <ul class="small stack-sm">
            <li>
              Groups, app groups, apps, grants, clients, webhooks and settings in the file{" "}
              <b>replace</b> the ones here with the same id.
            </li>
            <li>
              People, memberships and favorites are only <b>added</b>; nobody here is changed or
              removed.
            </li>
            <li>
              Passkeys come back only if the backup is from the same passkey domain; otherwise
              people need new enrollment links.
            </li>
          </ul>
          <label class="field">
            <span class="label">Backup file</span>
            <input name="file" type="file" accept="application/json,.json" required />
          </label>
          <div>
            <button class="btn" type="submit">
              <Icon name="upload" size="sm" />
              <span>Preview restore</span>
            </button>
          </div>
        </form>
      </SettingsCard>
    </>,
  ),
);

backupSettings.post("/backup/export", async (c) => {
  const backup = await exportBackup(c.env, actor(c));
  const day = new Date().toISOString().slice(0, 10);
  return c.body(JSON.stringify(backup, null, 2), 200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="edge-idp-backup-${day}.json"`,
    "cache-control": "no-store",
  });
});

backupSettings.post("/backup/:operation", async (c) => {
  const operation = c.req.param("operation");
  if (operation !== "preview" && operation !== "import") return c.notFound();
  const preview = operation === "preview";
  try {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new OpError("Choose a backup file.");
    if (file.size > MAX_BACKUP_BYTES) throw new OpError("That file is larger than 5 MB.");
    const raw = await file.text();
    const digest = await sha256Hex(raw);
    if (!preview && form.digest !== undefined && form.digest !== digest)
      throw new OpError("The file differs from the preview. Preview it again.");
    const r = await importBackup(c.env, parseBackup(raw), actor(c), preview);
    return settingsPage(
      c,
      "backup",
      <SettingsCard icon="upload" title={preview ? "Restore preview" : "Restore receipt"}>
        <div class="card-body stack">
          <p>
            {r.passkeys
              ? "Passkey domain matches."
              : "Different passkey domain. Credentials will need new enrollment."}
          </p>
          {preview ? (
            <p>
              Planned changes use the current database. Constraints are checked when you restore.
            </p>
          ) : (
            <p>
              Applied {r.applied} {r.applied === 1 ? "row" : "rows"}. Skipped {r.skipped}.
            </p>
          )}
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Planned additions</th>
                  <th>Planned replacements</th>
                  {!preview && <th>Applied</th>}
                  <th>Skipped</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {r.tables.map((t) => (
                  <tr key={t.table}>
                    <td>{t.table}</td>
                    <td>{t.additions}</td>
                    <td>{t.replacements}</td>
                    {!preview && <td>{t.applied}</td>}
                    <td>{t.skipped}</td>
                    <td>
                      {Object.entries(t.reasons).map(([reason, count]) => (
                        <div key={reason}>
                          {reason}: {count}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview && (
            <form
              method="post"
              action="/admin/settings/backup/import"
              enctype="multipart/form-data"
              class="stack-sm"
            >
              <input type="hidden" name="digest" value={digest} />
              <label>
                Select the reviewed file to apply it{" "}
                <input type="file" name="file" accept=".json" required />
              </label>
              <button class="btn primary" type="submit">
                Apply restore
              </button>
            </form>
          )}
          <a href="/admin/settings/backup">Back to backups</a>
        </div>
      </SettingsCard>,
    );
  } catch (e) {
    return failBack(c, "/admin/settings/backup", e);
  }
});
