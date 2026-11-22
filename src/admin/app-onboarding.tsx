import { Hono } from "hono";
import { getApp, getUserByEmail } from "../db";
import { connectionEvents, inviteToApp } from "../app-onboarding";
import { deliverLink } from "../invites";
import { Time, CopyField } from "../ui/components";
import { nowSec } from "../util";
import { actor, failBack, field, page } from "./shell";
import type { AdminVars } from "./shell";

export const onboardingAdmin = new Hono<AdminVars>();
const events: Record<string, string> = {
  CALLBACK_MATCHED: "Authorization request received. Callback matched.",
  SIGN_IN_PROBLEM: "Sign-in stopped. Open the support event for details.",
  CODE_ISSUED: "Authorization code issued.",
  TOKEN_ISSUED: "App redeemed the code for tokens.",
  CLIENT_AUTH_FAILED: "Client authentication failed. Check the app’s configured secret.",
  CODE_REJECTED: "Code exchange rejected. Check callback and PKCE settings.",
};
onboardingAdmin.get("/:id/onboarding", async (c) => {
  const app = await getApp(c.env.DB, c.req.param("id"));
  if (!app) return c.notFound();
  const start = Number(c.req.query("since")) || nowSec();
  const path = "/admin/apps/" + encodeURIComponent(app.id);
  const rows = app.client_id ? await connectionEvents(c.env.DB, app.client_id, start) : [];
  const { results } = await c.env.DB.prepare(
    "SELECT u.id,u.name, i.invited_at, EXISTS(SELECT 1 FROM webauthn_credentials k WHERE k.user_id=u.id) enrolled, i.first_signin_at signed FROM app_invitations i JOIN users u ON u.id=i.user_id WHERE i.app_id=? ORDER BY i.invited_at DESC LIMIT 50",
  )
    .bind(app.id)
    .all<{ id: string; name: string; invited_at: number; enrolled: number; signed: number }>();
  return page(
    c,
    { active: "apps", title: app.name },
    <div class="stack">
      <h1>{app.name}</h1>
      {app.client_id && (
        <section class="card card-body">
          <h2>Test sign-in</h2>
          <p>
            Open the app and sign in, then refresh to see events for this client since{" "}
            <Time ts={start} />. Other people signing into this client also appear here.
          </p>
          <a href={app.url} target="_blank" rel="noopener">
            Open {app.name}
          </a>{" "}
          <a href={path + "/onboarding?since=" + start}>Refresh results</a>
          <ul>
            {rows.map((r) => (
              <li key={r.id}>
                <Time ts={r.created_at} /> {events[r.event]}{" "}
                <a href={"/admin/audit?q=event-" + r.id}>Event</a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form class="card card-body" method="post" action={path + "/requestable"}>
        <label>
          <input type="checkbox" name="enabled" value="1" checked={app.requestable} /> Show this app
          to members who can request access
        </label>
        <button>Save discovery setting</button>
      </form>
      <form class="card card-body stack-sm" method="post" action={path + "/invite-preview"}>
        <h2>Invite a person</h2>
        <label>
          Email <input type="email" name="email" required />
        </label>
        <label>
          Name for a new member <input name="name" maxLength={120} />
        </label>
        <button>Preview invite</button>
      </form>
      <section class="card card-body">
        <h2>Invitations</h2>
        <ul>
          {results.map((r) => (
            <li key={r.id}>
              {r.name} ·{" "}
              {r.signed
                ? "First client sign-in observed"
                : r.enrolled
                  ? "Passkey enrolled"
                  : "Invited"}{" "}
              · <Time ts={r.invited_at} />
            </li>
          ))}
        </ul>
      </section>
    </div>,
  );
});
onboardingAdmin.post("/:id/invite-preview", async (c) => {
  const form = await c.req.parseBody();
  const email = field(form, "email").trim(),
    name = field(form, "name").trim();
  const app = await getApp(c.env.DB, c.req.param("id"));
  if (!app) return c.notFound();
  const existing = await getUserByEmail(c.env.DB, email);
  return page(
    c,
    { active: "apps", title: "Review app invitation" },
    <form class="card card-body stack" method="post" action={`/admin/apps/${app.id}/invite`}>
      <h1>Invite to {app.name}</h1>
      <p>
        {email} will receive direct access without an app role.{" "}
        {existing
          ? "Their existing account will be used."
          : "A new member account can also open all-members apps."}{" "}
        The app’s own policies still apply.
      </p>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="name" value={name} />
      <button>Confirm invite</button>
    </form>,
  );
});
onboardingAdmin.post("/:id/invite", async (c) => {
  const form = await c.req.parseBody();
  try {
    const r = await inviteToApp(
      c.env.DB,
      c.env.ISSUER,
      {
        appId: c.req.param("id"),
        email: field(form, "email").trim(),
        name: field(form, "name").trim(),
      },
      actor(c),
    );
    const sent = await deliverLink(c.env, r.user, r.link, r.created ? "invite" : "app", r.appName);
    return page(
      c,
      { active: "apps", title: "App invitation" },
      <section class="card card-body">
        <h1>{sent?.emailed ? "Invitation emailed" : "Share this invitation"}</h1>
        <CopyField value={r.link} label="Invitation link" />
      </section>,
    );
  } catch (e) {
    return failBack(c, `/admin/apps/${c.req.param("id")}/onboarding`, e);
  }
});
