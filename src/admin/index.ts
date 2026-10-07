import { Hono } from "hono";
import { sessionUser } from "../session";
import { listApps, listClients, listGroups, listUsers } from "../db";
import type { AdminVars } from "./shell";
import { dashboardAdmin } from "./dashboard";
import { usersAdmin } from "./users";
import { userDetailAdmin } from "./user-detail";
import { groupsAdmin } from "./groups";
import { appsAdmin } from "./apps";
import { clientsAdmin } from "./clients";
import { auditAdmin, auditCsv } from "./audit";
import { connectAdmin } from "./connect";
import { tokensAdmin } from "./tokens";
import { metricsAdmin } from "./metrics";
import { settingsAdmin } from "./settings";

/**
 * Admin router. The middleware is the entire authorization story: an
 * authenticated session AND is_admin, or 403. There is no self-service path
 * to admin — the first admin comes from the seed script. (State-changing
 * requests are additionally same-origin checked in index.tsx.)
 */
export const admin = new Hono<AdminVars>();

// Hono middleware intentionally returns Response | void (short-circuit or pass-through).
// eslint-disable-next-line typescript/consistent-return
admin.use("*", async (c, next) => {
  const user = await sessionUser(c);
  if (!user)
    return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 302);
  if (!user.is_admin) return c.redirect("/", 302);
  c.set("admin", user);
  await next();
});

/** Command-palette index: pages + people + apps + clients + groups. */
admin.get("/palette.json", async (c) => {
  const db = c.env.DB;
  const [users, apps, clients, groups] = await Promise.all([
    listUsers(db),
    listApps(db),
    listClients(db),
    listGroups(db),
  ]);
  return c.json(
    [
      ...users.map((u) => ({
        kind: "Person",
        label: u.name,
        sub: u.email,
        href: `/admin/users/${u.id}`,
        icon: "user",
      })),
      ...groups.map((g) => ({
        kind: "Group",
        label: g.name,
        sub: g.description ?? "",
        href: `/admin/groups/${g.id}`,
        icon: "group",
      })),
      ...apps.map((a) => ({ kind: "App", label: a.name, sub: a.url, href: a.url, icon: "grid" })),
      ...clients.map((x) => ({
        kind: "Client",
        label: x.name,
        sub: x.id,
        href: `/admin/clients/${encodeURIComponent(x.id)}`,
        icon: "plug",
      })),
    ],
    200,
    { "cache-control": "no-store" },
  );
});

admin.get("/audit.csv", async (c) =>
  c.body(await auditCsv(c.env.DB), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    "cache-control": "no-store",
  }),
);

admin.route("/", dashboardAdmin);
admin.route("/users", usersAdmin);
admin.route("/users/:id", userDetailAdmin);
admin.route("/groups", groupsAdmin);
admin.route("/apps", appsAdmin);
admin.route("/clients", clientsAdmin);
admin.route("/audit", auditAdmin);
admin.route("/connect", connectAdmin);
admin.route("/tokens", tokensAdmin);
admin.route("/metrics", metricsAdmin);
admin.route("/settings", settingsAdmin);
// Old URLs from the previous UI.
admin.get("/access", (c) => c.redirect("/admin/connect", 301));
admin.get("/preferences", (c) => c.redirect("/admin/settings", 301));
admin.get("/theme", (c) => c.redirect("/admin/settings", 301));
admin.get("/mcp", (c) => c.redirect("/admin/metrics", 301));
