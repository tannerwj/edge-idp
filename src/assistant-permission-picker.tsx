export function JobSelection(props: { apps: { id: string; name: string }[]; write: boolean }) {
  return (
    <fieldset>
      <legend>Assistant permissions</legend>
      <label>
        Allowed action{" "}
        <select name="job">
          <option value="full">
            {props.write
              ? "Administer this identity server (all apps)"
              : "Read admin data (all apps)"}
          </option>
          <option value="inspect">Inspect connection health only</option>
          {props.write && <option value="invite">Invite existing members only</option>}
        </select>
      </label>
      <label>
        Apps for inspection or invitations{" "}
        <select name="jobApp" multiple>
          {props.apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <p class="muted small">
        Choosing inspection or invitations limits this assistant to the selected apps. Changing its
        approved permissions ends access through its earlier credentials.
      </p>
    </fieldset>
  );
}
