import type { App, Group, OidcClient } from "../db";
import type { AppGroup } from "../access";
import { Callout, GroupPicker, hueOf } from "../ui/components";

const HUES = [15, 45, 75, 115, 150, 180, 210, 240, 265, 295, 325, 350];

function hueBucket(app: App): string {
  return app.color ? String(Math.round(parseInt(app.color, 10) / 30) % 12) : hueOf(app.name);
}

export function Glyph(props: { app: App }) {
  const a = props.app;
  const emoji = !!a.icon && /\p{Extended_Pictographic}/u.test(a.icon);
  return (
    <span class="tile-mini" data-hue={hueBucket(a)}>
      <span class={emoji ? "glyph emoji" : "glyph"}>
        {a.icon || a.name.slice(0, 1).toUpperCase()}
      </span>
    </span>
  );
}

function ColorField(props: { app?: App }) {
  const a = props.app;
  return (
    <div class="field">
      <span class="label">Color</span>
      <div class="swatches">
        <label class="swatch" title="Automatic">
          <input type="radio" name="color" value="" checked={!a?.color} />
          <span class="auto"></span>
        </label>
        {HUES.map((h, i) => (
          <label key={String(h)} class="swatch" data-hue={String(i)}>
            <input type="radio" name="color" value={String(h)} checked={a?.color === String(h)} />
            <span></span>
          </label>
        ))}
      </div>
    </div>
  );
}

function PlacementFields(props: { app?: App; appGroups: AppGroup[] }) {
  const a = props.app;
  return (
    <div class="grid-2">
      <label class="field">
        <span class="label">App group</span>
        <select name="appGroup">
          <option value="" selected={!a?.app_group_id}>
            None
          </option>
          {props.appGroups.map((g) => (
            <option key={g.id} value={g.id} selected={a?.app_group_id === g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span class="label">Slug</span>
        <input
          name="slug"
          maxLength={40}
          pattern="[a-z0-9][a-z0-9-]*"
          value={a?.slug ?? ""}
          placeholder="from the name"
        />
        <span class="hint">The name in apps and roles claims. Access policies match on it.</span>
      </label>
    </div>
  );
}

function ClientField(props: { app?: App; clients: OidcClient[] }) {
  return (
    <label class="field">
      <span class="label">Sign-in client (optional)</span>
      <select name="clientId">
        <option value="" selected={!props.app?.client_id}>
          None
        </option>
        {props.clients
          .filter((c) => c.source === "admin")
          .map((c) => (
            <option key={c.id} value={c.id} selected={props.app?.client_id === c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <span class="hint">
        Link a client to let grants on its linked apps control who can sign in.
      </span>
    </label>
  );
}

export function AppForm(props: {
  app?: App;
  groups: Group[];
  clients: OidcClient[];
  appGroups: AppGroup[];
}) {
  const a = props.app;
  return (
    <>
      <div class="grid-2">
        <label class="field">
          <span class="label">Name</span>
          <input
            name="name"
            required
            maxLength={80}
            value={a?.name ?? ""}
            placeholder="Home Assistant"
          />
        </label>
        <label class="field">
          <span class="label">Icon</span>
          <input
            name="icon"
            maxLength={8}
            value={a?.icon ?? ""}
            placeholder="🏠  (emoji or letters)"
          />
        </label>
      </div>
      <label class="field">
        <span class="label">URL</span>
        <input
          name="url"
          type="url"
          required
          value={a?.url ?? ""}
          placeholder="https://home.example.com"
        />
      </label>
      <label class="field">
        <span class="label">Description</span>
        <input
          name="description"
          maxLength={200}
          value={a?.description ?? ""}
          placeholder="Optional one-liner"
        />
      </label>
      <PlacementFields app={a} appGroups={props.appGroups} />
      <ColorField app={a} />
      <ClientField app={a} clients={props.clients} />
      {a ? null : (
        <div class="field">
          <span class="label">Initial groups for a tile without a sign-in client</span>
          <GroupPicker name="groups" all={props.groups} selected={null} />
          <span class="hint">
            Leave empty for all members. For a linked client, manage grants in Access.
          </span>
        </div>
      )}
      <Callout icon="info">
        The launcher shows each app to the people its grants cover. Enforcement happens in your
        Cloudflare Access policy (match the <code>apps</code> claim) or in the app itself (match{" "}
        <code>roles</code>).
      </Callout>
    </>
  );
}
