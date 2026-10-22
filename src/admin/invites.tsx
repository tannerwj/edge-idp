import { Hono } from "hono";
import { getUser, listGroups } from "../db";
import type { Group } from "../db";
import * as ops from "../ops";
import { deliverLink, parseBulk, pendingInvites, revokeInvites } from "../invites";
import type { Delivery } from "../invites";
import { emailStatus } from "../email";
import { getInstanceSettings } from "../settings-cache";
import type { AdminVars, ACtx } from "./shell";
import { act, actor, failBack, field, fields, page } from "./shell";
import {
  Avatar,
  Callout,
  CopyField,
  Dialog,
  Empty,
  GroupPicker,
  PageHead,
  PostButton,
  Time,
} from "../ui/components";
import { Icon } from "../ui/icons";

export const invitesAdmin = new Hono<AdminVars>();

export async function emailOn(c: ACtx): Promise<boolean> {
  return emailStatus(c.env, await getInstanceSettings(c.env.DB)) === "ready";
}

function DeliveryNote(props: { delivery: Delivery | null; email: string }) {
  const d = props.delivery;
  if (!d) return null;
  if (d.emailed)
    return (
      <Callout tone="ok" icon="mail">
        Emailed to <b>{props.email}</b>. The link below is the same one, in case it doesn't arrive.
      </Callout>
    );
  return d.error ? (
    <Callout tone="warn">
      The email didn't go out ({d.error}). Send the link below yourself.
    </Callout>
  ) : null;
}

export async function revealLink(
  c: ACtx,
  userId: string,
  link: string,
  opts: { fresh: boolean; delivery: Delivery | null; validFor?: string },
) {
  const u = await getUser(c.env.DB, userId);
  const name = u?.name ?? "them";
  const first = name.split(" ")[0];
  const mail = `mailto:${encodeURIComponent(u?.email ?? "")}?subject=${encodeURIComponent(`Your ${c.env.RP_NAME} invite`)}&body=${encodeURIComponent(
    `Hi ${first},\n\nSet up your passkey for ${c.env.RP_NAME} here (valid for 7 days, works once):\n\n${link}\n`,
  )}`;
  return await page(
    c,
    {
      active: "users",
      title: opts.fresh ? "Invite ready" : "Enrollment link",
      crumbs: [
        { label: "People", href: "/admin/users" },
        { label: name, href: `/admin/users/${userId}` },
        { label: "Link" },
      ],
      narrow: true,
    },
    <div class="card">
      <div class="card-body stack">
        <div class="hero-icon ok">
          <Icon name={opts.delivery?.emailed ? "mail" : "check"} />
        </div>
        <div>
          <h1>{opts.fresh ? `${first} is invited` : "New enrollment link"}</h1>
          <p class="muted">
            The link works once, for {opts.validFor ?? "7 days"}, and is shown only now: only its
            hash is stored. Older unused links for {first} stopped working.
          </p>
        </div>
        <DeliveryNote delivery={opts.delivery} email={u?.email ?? ""} />
        <CopyField value={link} big label="enrollment link" />
        <div class="row wrap">
          {opts.delivery?.emailed ? null : (
            <a class="btn" href={mail}>
              <Icon name="mail" size="sm" />
              Email it
            </a>
          )}
          <button
            class="btn"
            type="button"
            data-share={link}
            data-share-title={`${c.env.RP_NAME} invite`}
          >
            <Icon name="arrowUpRight" size="sm" />
            Share…
          </button>
          <button class="btn" type="button" data-qr={link}>
            <Icon name="qr" size="sm" />
            Show QR
          </button>
          <a class="btn ghost right" href={`/admin/users/${userId}`}>
            Done
          </a>
        </div>
        <div class="qr" data-qr-target hidden></div>
      </div>
    </div>,
  );
}

function BulkDialog(props: { groups: Group[]; emailReady: boolean }) {
  return (
    <Dialog
      id="bulk-invite"
      sheet
      title="Invite several people"
      lede="One person per line: an email address, optionally with a name, like Ada Lovelace <ada@example.com> or ada@example.com, Ada."
      action="/admin/users/invites"
      submit="Create invites"
    >
      <label class="field">
        <span class="label">People</span>
        <textarea name="people" rows={8} required placeholder="Ada Lovelace <ada@example.com>" />
      </label>
      <div class="field">
        <span class="label">Groups for everyone</span>
        <GroupPicker name="groups" all={props.groups} selected={[]} />
      </div>
      {props.emailReady ? (
        <label class="switch">
          <input type="checkbox" name="sendEmail" value="1" checked />
          <span class="track"></span>
          <span>Email each person their invite</span>
        </label>
      ) : null}
    </Dialog>
  );
}

invitesAdmin.get("/", async (c) => {
  const [invites, groups, ready] = await Promise.all([
    pendingInvites(c.env.DB),
    listGroups(c.env.DB),
    emailOn(c),
  ]);
  return page(
    c,
    {
      active: "users",
      title: "Pending invites",
      crumbs: [{ label: "People", href: "/admin/users" }, { label: "Pending invites" }],
    },
    <>
      <PageHead
        title="Pending invites"
        lede="People with an unused enrollment link. Resending makes a new link and retires the old one."
        actions={
          <button class="btn primary" type="button" data-open="bulk-invite">
            <Icon name="userPlus" size="sm" />
            <span>Invite several</span>
          </button>
        }
      />
      <div class="card">
        {invites.length ? (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Sent</th>
                  <th>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <div class="cell-user">
                        <Avatar name={i.name} seed={i.id} />
                        <div class="truncate">
                          <a class="name" href={`/admin/users/${i.id}`}>
                            {i.name}
                          </a>
                          <div class="sub truncate">{i.email}</div>
                        </div>
                      </div>
                    </td>
                    <td class="muted small nowrap">
                      <Time ts={i.sent_at} />
                    </td>
                    <td class="muted small nowrap">
                      <Time ts={i.expires_at} />
                    </td>
                    <td class="actions">
                      <div class="row-sm right">
                        <PostButton
                          action={`/admin/users/invites/${i.id}/resend`}
                          label={ready ? "Resend" : "New link"}
                          icon={ready ? "send" : "link"}
                          fields={ready ? { sendEmail: "1" } : {}}
                        />
                        <PostButton
                          action={`/admin/users/invites/${i.id}/revoke`}
                          label="Revoke"
                          class="btn sm ghost danger"
                          confirm={`Revoke ${i.name}'s invite? The link stops working; their account stays.`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="mail" title="No pending invites" />
        )}
      </div>
      <BulkDialog groups={groups} emailReady={ready} />
    </>,
  );
});

invitesAdmin.post("/:id/resend", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  try {
    const link = await ops.mintEnrollmentLink(c.env.DB, c.env.ISSUER, id, actor(c));
    const user = await getUser(c.env.DB, id);
    const delivery =
      user && field(form, "sendEmail") === "1"
        ? await deliverLink(c.env, user, link, "relink")
        : null;
    return revealLink(c, id, link, { fresh: false, delivery });
  } catch (e) {
    return failBack(c, "/admin/users/invites", e);
  }
});

invitesAdmin.post("/:id/revoke", async (c) => {
  const id = c.req.param("id");
  return act(c, "/admin/users/invites", "Invite revoked", () =>
    revokeInvites(c.env.DB, id, actor(c)),
  );
});

async function inviteOne(
  c: ACtx,
  person: { name: string; email: string },
  groups: string[],
  send: boolean,
): Promise<{ name: string; email: string; link?: string; result: string }> {
  try {
    const r = await ops.createUser(c.env.DB, c.env.ISSUER, { ...person, groups }, actor(c));
    const delivery = send
      ? await deliverLink(c.env, { ...person, public: 0 }, r.enrollmentLink, "invite")
      : null;
    if (delivery?.emailed) return { ...person, result: "Emailed" };
    return { ...person, link: r.enrollmentLink, result: delivery?.error ?? "Link ready" };
  } catch (e) {
    if (!(e instanceof ops.OpError)) throw e;
    return { ...person, result: e.message };
  }
}

invitesAdmin.post("/", async (c) => {
  const form = await c.req.parseBody({ all: true });
  let parsed;
  try {
    parsed = parseBulk(field(form, "people"));
  } catch (e) {
    return failBack(c, "/admin/users/invites", e);
  }
  const groups = fields(form, "groups");
  const send = field(form, "sendEmail") === "1";
  const results = [];
  for (const person of parsed.people) results.push(await inviteOne(c, person, groups, send));
  return page(
    c,
    {
      active: "users",
      title: "Invites",
      crumbs: [{ label: "People", href: "/admin/users" }, { label: "Invites" }],
      narrow: true,
    },
    <div class="stack-lg">
      <PageHead
        title={`${results.filter((r) => r.result === "Emailed" || r.link).length} invited`}
        lede="Links shown here are shown only once."
      />
      {parsed.errors.length ? <Callout tone="warn">{parsed.errors.join(" · ")}</Callout> : null}
      {results.map((r) => (
        <div class="card" key={r.email}>
          <div class="card-body stack-sm">
            <div class="row-sm">
              <b>{r.name}</b>
              <span class="muted">{r.email}</span>
              <span
                class={r.link || r.result === "Emailed" ? "badge ok right" : "badge warn right"}
              >
                {r.result}
              </span>
            </div>
            {r.link ? <CopyField value={r.link} label={`link for ${r.name}`} /> : null}
          </div>
        </div>
      ))}
      <a class="btn" href="/admin/users/invites">
        Done
      </a>
    </div>,
  );
});
