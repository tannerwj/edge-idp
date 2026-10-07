import type { listAccessApps } from "../cf-access";
import { Callout, Empty, PostButton } from "../ui/components";
import { Icon } from "../ui/icons";

type AccessList = Awaited<ReturnType<typeof listAccessApps>>;

export function CloudflareSection({
  cf,
  cfError,
  imported,
}: {
  cf: AccessList | null;
  cfError: string | null;
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
                      <span class="muted">No allow policies</span>
                    )}
                  </td>
                  <td class="actions">
                    {imported.has(x.id) ? (
                      <span class="badge ok">In launcher</span>
                    ) : x.domain ? (
                      <PostButton
                        action="/admin/apps/import"
                        fields={{
                          cfAppId: x.id,
                          name: x.name,
                          url: `https://${x.domain}`,
                          groups: x.groups.join(","),
                        }}
                        label="Add to launcher"
                        class="btn sm"
                      />
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
