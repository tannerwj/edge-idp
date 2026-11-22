import { lastDay } from "./request-dates";
import { Hono } from "hono";
import type { Env } from "./config";
import { getSession } from "./session";
import { appsForUser } from "./access";
import { AppShell, uiFor } from "./ui/layout";
import { Time } from "./ui/components";
import { viewerOf } from "./account";
import { newId } from "./util";

export const memberRequests = new Hono<{ Bindings: Env }>();
interface RequestRow {
  id: string;
  app_id: string;
  name: string;
  requested_at: number;
  decision: string | null;
  decision_note: string | null;
  approved_until: number | null;
  extendable: number;
  previous_end: number | null;
}

const latestTemporaryGrant = `a.requestable=1 AND t.expires_at>unixepoch()
 AND NOT EXISTS(SELECT 1 FROM temporary_app_grants newer WHERE newer.app_id=r.app_id AND newer.user_id=r.user_id AND newer.expires_at>t.expires_at)
 AND NOT EXISTS(SELECT 1 FROM app_grants permanent WHERE permanent.app_id=r.app_id AND permanent.user_id=r.user_id)`;
memberRequests.get("/requests", async (c) => {
  const s = await getSession(c);
  if (!s) return c.redirect("/login?next=/requests");
  if (s.user.public) return c.notFound();
  const [rows, apps] = await Promise.all([
    c.env.DB.prepare(`SELECT r.*,a.name,
 ${latestTemporaryGrant}
 AND NOT EXISTS(SELECT 1 FROM access_requests p WHERE p.app_id=r.app_id AND p.user_id=r.user_id AND p.decision IS NULL) AS extendable
 FROM access_requests r JOIN apps a ON a.id=r.app_id LEFT JOIN temporary_app_grants t ON t.id='temporary:'||r.id WHERE r.user_id=? ORDER BY r.requested_at DESC,r.rowid DESC`)
      .bind(s.user.id)
      .all<RequestRow>(),
    appsForUser(c.env.DB, s.user.id),
  ]);
  return c.html(
    <AppShell ui={await uiFor(c)} viewer={viewerOf(s)} active="home" title="My requests">
      <section class="card card-body">
        <h1>My requests</h1>
        {!rows.results.length && <p>You have no access requests yet.</p>}
        <ul class="list">
          {rows.results.map((r) => (
            <li key={r.id}>
              <div class="grow">
                <h2>{r.name}</h2>
                <p>
                  {r.previous_end ? "Extension" : "Access"} requested <Time ts={r.requested_at} /> ·{" "}
                  {r.decision ?? "Pending"}
                </p>
                {r.approved_until && <p>Last day of access (UTC) {lastDay(r.approved_until)}</p>}
                {r.decision_note && <p>{r.decision_note}</p>}
                {r.decision === "approved" && apps.some((a) => a.id === r.app_id) && (
                  <a href={"/open/" + r.app_id}>Open app</a>
                )}
                {!!r.extendable && (
                  <form method="post" action={"/requests/" + r.id + "/extend"}>
                    <button>Request extension</button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </AppShell>,
  );
});
memberRequests.post("/requests/:id/extend", async (c) => {
  const s = await getSession(c);
  if (!s || s.user.public) return c.notFound();
  await c.env.DB.prepare(`INSERT OR IGNORE INTO access_requests(id,user_id,app_id,requested_at,previous_end)
 SELECT ?,r.user_id,r.app_id,unixepoch(),t.expires_at FROM access_requests r JOIN apps a ON a.id=r.app_id
 JOIN temporary_app_grants t ON t.id='temporary:'||r.id WHERE r.id=? AND r.user_id=? AND ${latestTemporaryGrant}`)
    .bind(newId(), c.req.param("id"), s.user.id)
    .run();
  return c.redirect("/requests", 303);
});
