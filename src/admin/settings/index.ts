import { Hono } from "hono";
import type { AdminVars } from "../shell";
import { aboutSettings } from "./about";
import { clientSettings } from "./clients";
import { cloudflareSettings } from "./cloudflare";
import { emailSettings } from "./email";
import { generalSettings } from "./general";
import { keySettings } from "./keys";
import { backupSettings } from "./backup";
import { notificationSettings } from "./notifications";
import { signInSettings } from "./sign-in";

export const settingsAdmin = new Hono<AdminVars>();

for (const r of [
  generalSettings,
  signInSettings,
  emailSettings,
  notificationSettings,
  clientSettings,
  keySettings,
  backupSettings,
  cloudflareSettings,
  aboutSettings,
])
  settingsAdmin.route("/", r);
