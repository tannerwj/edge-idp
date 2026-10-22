import { Hono } from "hono";
import { getClient } from "../db";
import type { OidcClient } from "../db";
import * as ops from "../ops";
import { MAX_AUTH_AGES } from "../ops-apps";
import type { AdminVars } from "./shell";
import { act, actor, field } from "./shell";
import { Icon } from "../ui/icons";

export const clientPolicyAdmin = new Hono<AdminVars>();

const AGE_LABEL: Record<number, string> = {
  0: "Any age (the session's own 30 days)",
  3600: "Signed in within the last hour",
  43200: "Signed in within the last 12 hours",
  86400: "Signed in within the last day",
  604800: "Signed in within the last week",
};

export function SignInPolicyCard({ client }: { client: OidcClient }) {
  return (
    <form
      class="card"
      method="post"
      action={`/admin/clients/${encodeURIComponent(client.id)}/sign-in`}
    >
      <div class="card-head">
        <Icon name="shield" />
        <div class="grow">
          <h2>Sign-in policy</h2>
          <div class="sub">
            Ask for a fresh sign-in before this app gets a code. Useful for apps that hold money,
            files or admin rights.
          </div>
        </div>
      </div>
      <div class="card-body stack">
        <label class="check">
          <input type="checkbox" name="requirePasskey" value="1" checked={client.require_passkey} />
          <span>
            Require a passkey sign-in
            <span class="sub">
              People signed in with an email link are asked for their passkey first.
            </span>
          </span>
        </label>
        <label class="field">
          <span class="label">How recent the sign-in must be</span>
          <select name="maxAuthAge">
            {MAX_AUTH_AGES.map((a) => (
              <option key={a} value={String(a)} selected={(client.max_auth_age ?? 0) === a}>
                {AGE_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div class="card-foot">
        <button class="btn primary right" type="submit">
          Save policy
        </button>
      </div>
    </form>
  );
}

clientPolicyAdmin.post("/:id/sign-in", async (c) => {
  const client = await getClient(c.env.DB, c.req.param("id"));
  if (!client) return c.notFound();
  const form = await c.req.parseBody();
  const back = `/admin/clients/${encodeURIComponent(client.id)}`;
  return act(c, back, "Sign-in policy saved", () =>
    ops.setClientSignInPolicy(
      c.env.DB,
      client,
      {
        requirePasskey: field(form, "requirePasskey") === "1",
        maxAuthAge: Number(field(form, "maxAuthAge")) || 0,
      },
      actor(c),
    ),
  );
});
