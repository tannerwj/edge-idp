import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { startLocal } from "./instances.mjs";

const port = 19215;
const base = `http://localhost:${port}`;
const instance = await startLocal({ issuer: base, port });
try {
  const token = randomUUID();
  const hash = createHash("sha256").update(token).digest("hex");
  await instance.sql(`INSERT INTO users(id,name,email,is_admin,created_at,updated_at) VALUES('operator','Ada Owner','owner@example.test',1,1,1);
    INSERT INTO sessions(id_hash,user_id,created_at,last_seen_at,expires_at,step_up_at) VALUES('${hash}','operator',unixepoch(),unixepoch(),unixepoch()+3600,unixepoch());`);
  const headers = { cookie: `__Host-idp_session=${token}` };
  const request = (path, form) =>
    fetch(base + path, {
      headers,
      redirect: "manual",
      ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
    });
  for (const [first, last, budget] of [
    [1, 16, 90 * 1024],
    [17, 64, 280 * 1024],
  ]) {
    await instance.sql(`WITH RECURSIVE n(i) AS (SELECT ${first} UNION ALL SELECT i+1 FROM n WHERE i<${last})
      INSERT INTO apps(id,name,url,created_at) SELECT 'tile-'||i,'App '||i,'https://example.test/'||i,1 FROM n`);
    const response = await request("/admin/apps");
    assert.equal(response.status, 200);
    const html = await response.text();
    const dialogs = (html.match(/<dialog\b/g) ?? []).length;
    const bytes = Buffer.byteLength(html);
    assert.ok(
      dialogs <= 2 && bytes <= budget,
      `Catalog size: ${last} apps, ${dialogs} dialogs, ${bytes} bytes`,
    );
    console.log(`Catalog: ${last} apps, ${dialogs} dialogs, ${bytes} bytes`);
  }
  const editor = await (await request("/admin/apps?editor=edit-tile-1")).text();
  assert.match(editor, /<dialog id="edit-tile-1"/);
  assert.doesNotMatch(editor, /<dialog id="edit-tile-2"/);
  const opts = {
    cfAppId: "access-example",
    name: "Imported app",
    url: "https://import.example.test",
  };
  const count = async () =>
    (await instance.sql("SELECT COUNT(*) AS n FROM apps WHERE cf_app_id='access-example'"))[0].n;
  await request("/admin/apps/import", opts);
  assert.equal(await count(), 0);
  const selected = { ...opts, audience: "members" };
  assert.match(await (await request("/admin/apps/import/preview", selected)).text(), /Ada Owner/);
  assert.equal(await count(), 0);
  const added = await request("/admin/apps/import", selected);
  assert.equal(added.status, 303);
  assert.equal(await count(), 1);
  const backup = {
    format: "edge-idp-backup",
    version: 1,
    rp_id: "elsewhere.example",
    tables: {
      groups: [
        { id: "g", name: "drill", created_at: 1 },
        { id: "g-missing-name", created_at: 1 },
      ],
      webauthn_credentials: [{ id: "unused-key" }],
      instance_settings: [{ key: "not-an-exportable-setting", value: "ignored" }],
    },
  };
  const upload = new FormData();
  upload.set(
    "file",
    new Blob([JSON.stringify(backup)], { type: "application/json" }),
    "receipt.json",
  );
  const result = await fetch(base + "/admin/settings/backup/import", {
    method: "POST",
    headers,
    body: upload,
  });
  const receipt = await result.text();
  for (const reason of [
    "Applied 1 row. Skipped 3.",
    "Required field missing",
    "Different passkey domain",
    "Excluded setting or outbound URL",
  ])
    assert.ok(receipt.includes(reason), reason);
  const form = {
    template: "grafana",
    base: "https://grafana.example.test",
    groups: "",
    redirects: "",
  };
  assert.match(await (await request("/admin/connect/preview", form)).text(), /All members/);
  assert.match(await (await request("/admin/connect/apply", form)).text(), /One-time pickup token/);
  assert.match(
    await (await request("/admin/connect/apply", form)).text(),
    /Use the existing app credential/,
  );
  console.log("Admin connection, audience preview and on-demand editors passed");
} finally {
  await instance.stop();
}
