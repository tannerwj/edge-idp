import { Hono } from "hono";
import { sessionUser } from "../session";
import type { AdminVars } from "./shell";
import { usersAdmin } from "./users";
import { userDetailAdmin } from "./user-detail";
import { groupsAdmin } from "./groups";
import { clientsAdmin } from "./clients";
import { auditAdmin } from "./audit";
import { themeAdmin } from "./theme";

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

admin.route("/", usersAdmin);
admin.route("/users/:id", userDetailAdmin);
admin.route("/groups", groupsAdmin);
admin.route("/clients", clientsAdmin);
admin.route("/audit", auditAdmin);
admin.route("/theme", themeAdmin);
