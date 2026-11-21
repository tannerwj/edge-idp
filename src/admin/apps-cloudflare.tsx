import { Hono } from "hono";
import { createApp } from "../ops-apps";
import { OpError, parseGroupList } from "../ops-core";
import { actor, failBack, field, fields, page } from "./shell";
import type { AdminVars } from "./shell";
import { setFlash } from "../ui/layout";
import type { listAccessApps } from "../cf-access";
import { Callout, Empty } from "../ui/components";
import { Icon } from "../ui/icons";

type AccessList = Awaited<ReturnType<typeof listAccessApps>>;

export function CloudflareSection({
  cf,
  cfError,
  imported,
  groups,
}: {
  cf: AccessList | null;
  cfError: string | null;
  groups: { name: string }[];
  imported: Set<string | null>;
}) {
  return (
    <section class="card section-gap" id="cloudflare">
      <div class="card-head">
        <Icon name="cloud" />
        <div class="grow">
          <h2>Cloudflare Access applications</h2>
          <div class="sub">
            {cf?.idp ? (
              <>
                This IdP is registered in Access as <b>{cf.idp.name}</b>. Groups below come from
                policies with an <code>oidc groups</code> rule for it.
              </>
            ) : cf ? (
              "No Access identity provider points at this server yet — see Connect."
            ) : null}
          </div>
        </div>
      </div>
      {cfError ? (
        <div class="card-body">
          <Callout tone="bad">Couldn't reach the Cloudflare API: {cfError}</Callout>
        </div>
      ) : cf && cf.apps.length ? (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Signs in with us</th>
                <th>Policies</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cf.apps.map((x) => (
                <tr key={x.id}>
                  <td>
                    <div class="name">{x.name}</div>
                    <div class="muted small mono">{x.domain ?? x.type}</div>
                  </td>
                  <td>
                    {x.usesUs ? (
                      <span class="badge ok dot">Yes</span>
                    ) : (
                      <span class="badge">No</span>
                    )}
                  </td>
                  <td class="small text-2">
                    {x.policies.length ? (
                      x.policies.map((p) => <div key={p}>{p}</div>)
                    ) : (
                      <span class="muted">Policy details unavailable</span>
                    )}
                  </td>
                  <td class="actions">
                    {imported.has(x.id) ? (
                      <span class="badge ok">In launcher</span>
                    ) : x.domain ? (
                      <details>
                        <summary>Review import</summary>
                        <form method="post" action="/admin/apps/import/preview" class="stack-sm">
                          <input type="hidden" name="cfAppId" value={x.id} />
                          <input type="hidden" name="name" value={x.name} />
                          <input type="hidden" name="url" value={`https://${x.domain}`} />
                          <p>
                            Referenced OIDC groups: {x.groups.join(", ") || "None identified"}.
                            Other policy conditions stay in Cloudflare.
                          </p>
                          <label>
                            Who should see the tile?{" "}
                            <select name="audience" required multiple>
                              <option value="none">Nobody yet</option>
                              <option value="members">All members</option>
                              {groups.map((g) => (
                                <option key={g.name} value={"group:" + g.name}>
                                  {g.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button type="submit" class="btn sm">
                            Preview audience
                          </button>
                        </form>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="cloud" title="No Access applications found" />
      )}
    </section>
  );
}

export const importAdmin = new Hono<AdminVars>();

function importAudience(choices: string[]) {
  const groups = choices
    .filter((v) => v.startsWith("group:") && v.length > 6)
    .map((v) => v.slice(6));
  const members = choices.length === 1 && choices[0] === "members";
  const none = choices.length === 1 && choices[0] === "none";
  if (!members && !none && (!groups.length || groups.length !== choices.length))
    throw new OpError("Choose groups, all members, or nobody.");
  return { groups, members, none };
}

importAdmin.post("/:operation?", async (c) => {
  const operation = c.req.param("operation");
  if (operation && operation !== "preview") return c.notFound();
  const form = await c.req.parseBody({ all: true });
  const selected = fields(form, "audience");
  const db = c.env.DB;
  try {
    const { groups, members, none } = importAudience(selected);
    const names = await parseGroupList(db, groups);
    const input = {
      name: field(form, "name"),
      url: field(form, "url"),
      cfAppId: field(form, "cfAppId"),
    };
    if (operation === "preview") {
      const people = await db
        .prepare(`SELECT name FROM users WHERE disabled=0 AND ((?1=1 AND public=0) OR id IN
        (SELECT m.user_id FROM group_members m JOIN groups g ON g.id=m.group_id WHERE g.name IN (SELECT value FROM json_each(?2)))) ORDER BY name`)
        .bind(members ? 1 : 0, JSON.stringify(names))
        .all<{ name: string }>();
      return page(
        c,
        { active: "apps", title: "Review launcher audience" },
        <section class="card">
          <div class="card-body stack-sm">
            <h2>{input.name}</h2>
            <p>{input.url}</p>
            <p>
              Launcher audience: {members ? "All members" : none ? "Nobody yet" : names.join(", ")}
            </p>
            <p>
              {people.results.length} people currently qualify.{" "}
              {people.results.map((u) => u.name).join(", ")}
            </p>
            <p>Cloudflare Access continues to evaluate the destination's policies.</p>
            <form action="/admin/apps/import" method="post">
              {Object.entries(input).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              {selected.map((v) => (
                <input key={v} type="hidden" name="audience" value={v} />
              ))}
              <button class="btn primary" type="submit">
                Add to launcher
              </button>
            </form>
            <a href="/admin/apps?cf=1#cloudflare">Back to import</a>
          </div>
        </section>,
      );
    }
    await createApp(db, { ...input, allowedGroups: names, seedGrants: !none }, actor(c));
    setFlash(c, "Added to launcher", "ok");
    return c.redirect("/admin/apps?cf=1#cloudflare", 303);
  } catch (e) {
    return failBack(c, "/admin/apps?cf=1#cloudflare", e);
  }
});
