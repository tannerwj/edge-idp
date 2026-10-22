import { Hono } from "hono";
import { approveRecovery, dismissRecovery, pendingRecovery } from "../recovery";
import type { AdminVars } from "./shell";
import { act, actor, failBack, field, page } from "./shell";
import { emailOn, revealLink } from "./invites";
import { Avatar, Empty, PageHead, PostButton, Time } from "../ui/components";

export const recoveryAdmin = new Hono<AdminVars>();

recoveryAdmin.get("/", async (c) => {
  const [requests, ready] = await Promise.all([pendingRecovery(c.env.DB), emailOn(c)]);
  const self = c.get("admin").id;
  return page(
    c,
    {
      active: "users",
      title: "Sign-in help",
      crumbs: [{ label: "People", href: "/admin/users" }, { label: "Sign-in help" }],
    },
    <>
      <PageHead
        title="Sign-in help"
        lede="People who asked for help after losing their passkey. Approving sends them a one-time link, valid for an hour, to set up a new one; their other passkeys keep working."
      />
      <div class="card">
        {requests.length ? (
          <ul class="list">
            {requests.map((r) => (
              <li key={r.id} class="row">
                <Avatar name={r.name} seed={r.user_id} />
                <div class="grow truncate">
                  <a class="name" href={`/admin/users/${r.user_id}`}>
                    {r.name}
                  </a>
                  <div class="sub truncate">
                    {r.email} · asked <Time ts={r.created_at} />
                  </div>
                </div>
                {r.user_id === self ? (
                  <span class="muted small">Another admin has to approve this</span>
                ) : (
                  <PostButton
                    action={`/admin/users/recovery/${r.id}/approve`}
                    label={ready ? "Approve and email" : "Approve"}
                    icon="check"
                    class="btn sm primary"
                    fields={ready ? { sendEmail: "1" } : {}}
                    confirm={`Send ${r.name} a link to add a passkey? Make sure the request really came from them.`}
                  />
                )}
                <PostButton
                  action={`/admin/users/recovery/${r.id}/dismiss`}
                  label="Dismiss"
                  class="btn sm ghost"
                />
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="key" title="Nobody needs help right now" />
        )}
      </div>
    </>,
  );
});

recoveryAdmin.post("/:id/approve", async (c) => {
  const form = await c.req.parseBody();
  try {
    const r = await approveRecovery(
      c.env,
      c.req.param("id"),
      field(form, "sendEmail") === "1",
      actor(c),
    );
    return revealLink(c, r.userId, r.link, {
      fresh: false,
      delivery: r.delivery,
      validFor: "1 hour",
    });
  } catch (e) {
    return failBack(c, "/admin/users/recovery", e);
  }
});

recoveryAdmin.post("/:id/dismiss", async (c) =>
  act(c, "/admin/users/recovery", "Request dismissed", () =>
    dismissRecovery(c.env.DB, c.req.param("id"), actor(c)),
  ),
);
