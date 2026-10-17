import { audit, getClient } from "./db";
import type { App } from "./db";
import { TEMPLATES, templateById } from "./app-templates";
import type { AppConfig } from "./app-templates";
import { createPickup, PICKUP_TTL } from "./secret-pickup";
import { createApp, createClient, rotateClientSecret, updateClient } from "./ops-apps";
import { appByRef } from "./ops-access";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";

export interface ConnectInput {
  template: string;
  baseUrl: string;
  app?: string;
  name?: string;
  appGroup?: string;
  icon?: string;
  groups?: string[];
  redirectUris?: string[];
}

export interface ConnectResult {
  app: { id: string; slug: string | null; name: string };
  client_id: string;
  rotated: boolean;
  redirect_uris: string[];
  issuer: string;
  discovery: string;
  secret_pickup: { url: string; token: string; expires_in: number };
  apply: "api" | "env" | "ui";
  config: AppConfig;
  secret_placeholder: string;
  notes: string[];
  docs: string;
}

function baseUrlOf(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error();
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    throw new OpError("base_url must be the app's https URL, e.g. https://grafana.example.com");
  }
}

async function targetApp(
  db: D1Database,
  input: ConnectInput,
  base: string,
  a: Actor,
): Promise<App> {
  if (input.app) return appByRef(db, input.app);
  const t = templateById(input.template);
  const id = await createApp(
    db,
    {
      name: input.name || t?.name || base,
      url: base,
      icon: input.icon || t?.icon,
      appGroup: input.appGroup,
      allowedGroups: input.groups ?? [],
      seedGrants: !!input.groups?.length || !input.appGroup,
    },
    a,
  );
  return appByRef(db, id);
}

export async function connectApp(
  db: D1Database,
  issuer: string,
  input: ConnectInput,
  a: Actor,
): Promise<ConnectResult> {
  const t = templateById(input.template);
  if (!t)
    throw new OpError(`Unknown template. Use one of: ${TEMPLATES.map((x) => x.id).join(", ")}`);
  const base = baseUrlOf(input.baseUrl);
  const redirects = t.id === "generic" ? (input.redirectUris ?? []) : t.redirects(base);
  if (!redirects.length) throw new OpError("Pass redirect_uris for a generic app.");
  const app = await targetApp(db, input, base, a);
  const existing = app.client_id ? await getClient(db, app.client_id) : null;
  let clientId: string;
  let secret: string;
  if (existing) {
    await updateClient(db, existing, { redirectUris: redirects, requirePkce: t.pkce }, a);
    clientId = existing.id;
    secret = await rotateClientSecret(db, existing, a);
  } else {
    const created = await createClient(
      db,
      {
        name: app.name,
        redirectUris: redirects,
        clientType: "confidential",
        requirePkce: t.pkce,
        description: `Connected with the ${t.name} template`,
      },
      a,
    );
    if (!created.secret) throw new Error("connect: confidential client without a secret");
    clientId = created.id;
    secret = created.secret;
    await db.prepare("UPDATE apps SET client_id = ?1 WHERE id = ?2").bind(clientId, app.id).run();
  }
  const token = await createPickup(db, clientId, secret);
  await audit(db, "APP_CONNECTED", {
    clientId,
    detail: by(a, { app: app.slug, template: t.id, rotated: !!existing }),
  });
  return {
    app: { id: app.id, slug: app.slug, name: app.name },
    client_id: clientId,
    rotated: !!existing,
    redirect_uris: redirects,
    issuer,
    discovery: `${issuer}/.well-known/openid-configuration`,
    secret_pickup: { url: `${issuer}/client-secret/pickup`, token, expires_in: PICKUP_TTL },
    apply: t.apply,
    config: t.config({ issuer, clientId, baseUrl: base }),
    secret_placeholder: "${CLIENT_SECRET}",
    notes: t.notes,
    docs: t.docs,
  };
}
