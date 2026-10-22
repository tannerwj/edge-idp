import { Hono } from "hono";
import { adminStepUpOk, getSession } from "../session";
import { getInstanceSettings } from "../settings-cache";
import { setFlash } from "../ui/layout";
import { listApps, listClients, listGroups, listUsers } from "../db";
import type { ACtx, AdminVars } from "./shell";
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

export const admin = new Hono<AdminVars>();

const SENSITIVE = [
  /^\/admin\/users$/,
  /^\/admin\/users\/[^/]+\/(profile|role|member|enrollment|revoke-keys)$/,
  /^\/admin\/users\/[^/]+\/keys\/[^/]+\/remove$/,
  /^\/admin\/tokens$/,
  /^\/admin\/clients$/,
  /^\/admin\/clients\/[^/]+(\/rotate)?$/,
  /^\/admin\/settings(\/.*)?$/,
];

export function isSensitiveAdminPost(method: string, path: string): boolean {
  return method === "POST" && SENSITIVE.some((re) => re.test(path));
}

function backTo(c: ACtx): string {
  const ref = c.req.header("referer");
  try {
    const u = new URL(ref ?? "");
    if (u.pathname.startsWith("/admin/") || u.pathname === "/admin") return u.pathname + u.search;
  } catch {}
  return "/admin";
}

// eslint-disable-next-line typescript/consistent-return
admin.use("*", async (c, next) => {
  const session = await getSession(c);
  const path = new URL(c.req.url).pathname;
  if (!session) return c.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
  if (!session.user.is_admin) return c.redirect("/", 302);
  if (isSensitiveAdminPost(c.req.method, path)) {
    const { adminStepUp } = await getInstanceSettings(c.env.DB);
    if (!adminStepUpOk(session, adminStepUp)) {
      setFlash(c, "Confirm it's you with your passkey, then try that again.", "bad");
      return c.redirect(`/login?reauth=1&next=${encodeURIComponent(backTo(c))}`, 303);
    }
  }
  c.set("admin", session.user);
  await next();
});

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
admin.get("/access", (c) => c.redirect("/admin/connect", 301));
admin.get("/preferences", (c) => c.redirect("/admin/settings", 301));
admin.get("/theme", (c) => c.redirect("/admin/settings", 301));
admin.get("/mcp", (c) => c.redirect("/admin/metrics", 301));
