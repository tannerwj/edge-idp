import { Hono } from "hono";
import { TEMPLATES } from "../app-templates";
import { connectApp } from "../ops-connect";
import { CopyField } from "../ui/components";

import { actor, failBack, field, page } from "./shell";
import type { AdminVars } from "./shell";

export const appConnectionAdmin = new Hono<AdminVars>();

export function ConnectionForm() {
  return (
    <section class="card">
      <div class="card-head">
        <h2>Connect an app</h2>
      </div>
      <form method="post" action="/admin/connect/preview" class="card-body stack-sm">
        <label>
          Template{" "}
          <select name="template">
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          App URL <input name="base" type="url" required />
        </label>
        <label>
          Existing tile (optional ID or slug) <input name="app" />
        </label>
        <label>
          Groups for a new tile <input name="groups" placeholder="family" />
        </label>
        <label>
          Callback URLs for the generic template <textarea name="redirects" />
        </label>
        <button class="btn" type="submit">
          Preview connection
        </button>
      </form>
    </section>
  );
}

appConnectionAdmin.post("/:operation", async (c) => {
  const op = c.req.param("operation");
  if (op !== "preview" && op !== "apply") return c.notFound();
  try {
    const form = await c.req.parseBody();
    const fields = {
      template: field(form, "template"),
      base: field(form, "base"),
      app: field(form, "app"),
      redirects: field(form, "redirects"),
      groups: field(form, "groups"),
    };
    const input = {
      template: fields.template,
      baseUrl: fields.base,
      app: fields.app || undefined,
      preview: op === "preview",
      redirectUris: fields.redirects.split(/[,\n]/),
      groups: fields.groups.split(/[,\s]+/),
    };
    const result = await connectApp(c.env.DB, c.env.ISSUER, input, actor(c));
    return page(
      c,
      { active: "connect", title: "App connection" },
      <section class="card">
        <div class="card-head">
          <h2>{result.app.name}</h2>
        </div>
        <div class="card-body stack-sm">
          <p>
            {result.status === "preview"
              ? "Review the client configuration before connecting."
              : "next" in result
                ? result.next
                : ""}
          </p>
          {"audience" in result && (
            <p>
              Launcher audience:{" "}
              {typeof result.audience === "string"
                ? result.audience
                : result.audience?.all_members
                  ? "All members"
                  : result.audience?.groups.join(", ")}
            </p>
          )}
          <p>Callback URLs: {result.redirect_uris.join(", ")}</p>
          <pre class="code">{JSON.stringify(result.config, null, 2)}</pre>
          {result.secret_pickup && (
            <>
              <p>
                POST the token in the form field <code>token</code> to {result.secret_pickup.url}{" "}
                within ten minutes. Put the response in the app’s client secret setting.
              </p>
              <CopyField value={result.secret_pickup.token} label="One-time pickup token" />
            </>
          )}
          {result.status === "preview" && (
            <form method="post" action="/admin/connect/apply">
              {Object.entries(fields).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <button class="btn primary" type="submit">
                Connect app
              </button>
            </form>
          )}
          <a href="/admin/connect">Back to Connect</a>
        </div>
      </section>,
    );
  } catch (e) {
    return failBack(c, "/admin/connect", e);
  }
});
