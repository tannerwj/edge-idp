import { claimsForClient, resolveAccess } from "./access";
import type { UserContext } from "./access";
import { getClient } from "./db";
import type { App } from "./db";
import { clientAccessProblem } from "./oauth-shared";

export async function inspectAccess(db: D1Database, ctx: UserContext, app: App) {
  const client = app.client_id ? await getClient(db, app.client_id) : null;
  const problem = ctx.user.disabled
    ? "Account disabled"
    : client
      ? clientAccessProblem(ctx, client, ["openid"])
      : null;
  const sharedTiles = client
    ? ctx.apps
        .filter((a) => a.client_id === client.id && a.id !== app.id && ctx.access.has(a.id))
        .map((a) => a.name)
    : [];
  const via = ctx.grants
    .filter((g) => resolveAccess([app], [g], ctx.subject).has(app.id))
    .map((g) => ({
      id: g.id,
      target: g.app_id ? "app" : "app group",
      role: g.role,
      subject: g.everyone
        ? "All members"
        : g.user_id
          ? ctx.user.name
          : ctx.groups[ctx.subject.groupIds.indexOf(g.group_id ?? "")],
    }));
  return {
    app: app.name,
    app_id: app.id,
    visible: !ctx.user.disabled && ctx.access.has(app.id),
    launcher_reason: ctx.user.disabled
      ? "Account disabled"
      : via.length
        ? "Covered by a grant"
        : "No matching app or app-group grant",
    via,
    client: client?.name ?? null,
    also_granted_through: sharedTiles,
    require_passkey: client?.require_passkey ?? false,
    max_auth_age: client?.max_auth_age ?? null,
    sign_in: client ? problem || "Eligible" : "No linked sign-in client",
    roles: client && !problem ? (claimsForClient(ctx.apps, ctx.access, client.id).roles ?? []) : [],
    enforcement: app.cf_app_id
      ? "Cloudflare Access also evaluates its policies."
      : "The destination application enforces its own permissions.",
  };
}
