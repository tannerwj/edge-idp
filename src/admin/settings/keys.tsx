import { Hono } from "hono";
import { jwksDocument } from "../../crypto";
import { rpIdFromIssuer } from "../../util";
import {
  canUseDatabaseKey,
  moveKeyToDatabase,
  rotateSigningKey,
  storedKeys,
} from "../../key-rotation";
import { getInstanceSettings, KEY_ROTATION_DAYS, SETTING_KEYS } from "../../settings-cache";
import type { KeyRotationDays } from "../../settings-cache";
import type { AdminVars } from "../shell";
import { act, actor, field } from "../shell";
import * as ops from "../../ops";
import { CopyField, PostButton, Time } from "../../ui/components";
import { ChoiceList, SaveFoot, SettingsCard, settingsPage } from "./shell";

export const keySettings = new Hono<AdminVars>();

const ROTATION: { value: KeyRotationDays; label: string; sub?: string }[] = [
  { value: "off", label: "Only when I rotate it" },
  { value: "90", label: "Every 90 days", sub: "Recommended." },
  { value: "180", label: "Every 180 days" },
  { value: "365", label: "Every year" },
];

function SecretModeSteps(props: { canMove: boolean }) {
  return (
    <div class="card-body stack">
      <p class="small">
        This instance signs with the <code>SIGNING_KEY_JWK</code> Worker secret. Rotate it with two
        secrets: publish the old key as <code>SIGNING_KEY_JWK_PREVIOUS</code>, set a new{" "}
        <code>SIGNING_KEY_JWK</code>, and delete the previous one after an hour (DEPLOY.md ›
        Rotating the signing key).
      </p>
      {props.canMove ? (
        <>
          <p class="small">
            Or keep the key in the database, encrypted with <code>SETUP_TOKEN</code>, so it can be
            rotated here and on a schedule. Moving copies the same key, so no token stops verifying.
            Afterwards, delete the <code>SIGNING_KEY_JWK</code> secret; until then it keeps winning.
          </p>
          <div>
            <PostButton
              action="/admin/settings/keys/move"
              label="Move the key into the database"
              icon="key"
              class="btn"
              confirm="Copy the signing key into the database (encrypted with SETUP_TOKEN)? Delete the SIGNING_KEY_JWK secret afterwards to start using it."
            />
          </div>
        </>
      ) : (
        <p class="muted small">
          To rotate from here instead, add a generated <code>SETUP_TOKEN</code> Worker secret (
          <code>node scripts/gen-setup-token.mjs</code>); it encrypts the key in the database.
        </p>
      )}
    </div>
  );
}

keySettings.get("/keys", async (c) => {
  const [jwks, rows, s] = await Promise.all([
    jwksDocument(c.env),
    storedKeys(c.env.DB),
    getInstanceSettings(c.env.DB),
  ]);
  const database = c.env.SIGNING_KEY_SOURCE === "database";
  const current = rows.find((r) => r.id === "current");
  const previous = rows.find((r) => r.id === "previous");
  return settingsPage(
    c,
    "keys",
    <>
      <SettingsCard
        icon="fingerprint"
        title="Identity"
        sub="Apps trust tokens from this issuer. Passkeys are bound to the passkey domain, so changing the issuer needs a planned migration (DEPLOY.md)."
      >
        <div class="card-body">
          <dl class="kv">
            <dt>Issuer</dt>
            <dd class="mono small">{c.env.ISSUER}</dd>
            <dt>Passkey domain (RP ID)</dt>
            <dd class="mono small">{rpIdFromIssuer(c.env.ISSUER)}</dd>
            <dt>JWKS</dt>
            <dd>
              <CopyField value={`${c.env.ISSUER}/jwks`} label="JWKS URL" />
            </dd>
          </dl>
        </div>
      </SettingsCard>
      <SettingsCard
        icon="key"
        title="Signing keys"
        sub={
          database
            ? "Kept in the database, encrypted with SETUP_TOKEN. A rotated-out key stays published for two hours so tokens it signed keep verifying."
            : "Kept in a Worker secret."
        }
        badge={<span class="badge">{database ? "Database" : "Secret"}</span>}
      >
        <div class="card-body">
          <ul class="list">
            {jwks.keys.map((k, i) => (
              <li key={k.kid ?? String(i)} class="row">
                <span class="mono small grow">{k.kid}</span>
                {i === 0 ? (
                  <span class="badge ok">
                    Signing
                    {database && current ? (
                      <>
                        {" "}
                        · since <Time ts={current.created_at} />
                      </>
                    ) : null}
                  </span>
                ) : (
                  <span class="badge">
                    Verify only
                    {database && previous?.retire_at ? (
                      <>
                        {" "}
                        · until <Time ts={previous.retire_at} />
                      </>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        {database ? (
          <div class="card-foot">
            <PostButton
              action="/admin/settings/keys/rotate"
              label="Rotate now"
              icon="refresh"
              class="btn right"
              confirm="Start signing with a new key now? The current key stays published for two hours."
            />
          </div>
        ) : (
          <SecretModeSteps canMove={canUseDatabaseKey(c.env)} />
        )}
      </SettingsCard>
      {database ? (
        <form method="post" action="/admin/settings/keys/schedule">
          <SettingsCard
            icon="clock"
            title="Automatic rotation"
            sub="The hourly job rotates the key once it's older than this."
          >
            <div class="card-body">
              <ChoiceList name="days" value={s.keyRotationDays} options={ROTATION} />
            </div>
            <SaveFoot />
          </SettingsCard>
        </form>
      ) : null}
    </>,
  );
});

keySettings.post("/keys/rotate", async (c) =>
  act(c, "/admin/settings/keys", "New signing key in use", () => rotateSigningKey(c.env, actor(c))),
);

keySettings.post("/keys/move", async (c) =>
  act(
    c,
    "/admin/settings/keys",
    "Key copied into the database. Delete the SIGNING_KEY_JWK secret to start using it.",
    () => moveKeyToDatabase(c.env, actor(c)),
  ),
);

keySettings.post("/keys/schedule", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/keys", "Saved", () =>
    ops.setChoiceSetting(
      c.env.DB,
      SETTING_KEYS.keyRotationDays,
      field(form, "days"),
      KEY_ROTATION_DAYS,
      actor(c),
    ),
  );
});
