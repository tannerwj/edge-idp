import { Hono } from "hono";
import { sessionUser } from "../session";
import type { AdminVars } from "./shell";
import { dashboardAdmin } from "./dashboard";
import { usersAdmin } from "./users";
import { userDetailAdmin } from "./user-detail";
import { clientsAdmin } from "./clients";
import { auditAdmin } from "./audit";
import { preferencesAdmin } from "./preferences";
import { tokensAdmin } from "./tokens";
import { accessAdmin } from "./access";
import { metricsAdmin } from "./metrics";

/**
 * Admin router. The middleware is the entire authorization story: an
 * authenticated session AND is_admin, or 403. There is no self-service path
 * to admin — the first admin comes from the seed script.
 */
export const admin = new Hono<AdminVars>();

// Hono middleware intentionally returns Response | void (short-circuit or pass-through).
// eslint-disable-next-line typescript/consistent-return
admin.use("*", async (c, next) => {
  const user = await sessionUser(c);
  if (!user || !user.is_admin) return c.text("Forbidden", 403);
  c.set("admin", user);
  await next();
});

admin.route("/", dashboardAdmin);
admin.route("/users", usersAdmin);
admin.route("/users/:id", userDetailAdmin);
admin.route("/clients", clientsAdmin);
admin.route("/access", accessAdmin);
admin.route("/audit", auditAdmin);
admin.route("/preferences", preferencesAdmin);
admin.route("/tokens", tokensAdmin);
admin.route("/metrics", metricsAdmin);
// Legacy redirects
admin.get("/groups", (c) => c.redirect("/admin/users", 301));
admin.get("/theme", (c) => c.redirect("/admin/preferences", 301));
admin.get("/mcp", (c) => c.redirect("/admin/metrics", 301));
