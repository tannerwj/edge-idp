import { getApp } from "../db";
import { connectionEvents, inviteToApp } from "../app-onboarding";
import { OpError } from "../ops-core";
import { nowSec } from "../util";
import { obj, str } from "./common";
import type { ToolDef } from "./common";

export const onboardingTools: ToolDef[] = [
  {
    name: "app_connection_status",
    description: "Read recent connection milestones for one linked app by exact app ID.",
    inputSchema: obj({ app: { type: "string" } }, ["app"]),
    write: false,
    handler: async ({ db }, args) => {
      const app = await getApp(db, str(args.app));
      if (!app?.client_id) throw new OpError("Choose a linked app.");
      return { app: app.name, events: await connectionEvents(db, app.client_id, nowSec() - 86400) };
    },
  },
  {
    name: "app_invite_member",
    description:
      "Give an existing member direct access to one app with no additional role. Returns their shareable launch link.",
    inputSchema: obj({ app: { type: "string" }, email: { type: "string" } }, ["app", "email"]),
    write: true,
    handler: async ({ db, env, actor }, args) => {
      const r = await inviteToApp(
        db,
        env.ISSUER,
        { appId: str(args.app), email: str(args.email).trim(), name: "", existingOnly: true },
        actor,
      );
      return { link: r.link };
    },
  },
];
