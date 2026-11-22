export const jobScope = (scope: string) =>
  scope.startsWith("mcp:inspect:") || scope.startsWith("mcp:invite:");
export const adminScope = (s: string) => s === "mcp" || s === "mcp:read" || jobScope(s);

export function permitsJob(scopes: string[] | undefined, tool: string, app?: unknown) {
  if (!scopes) return true;
  if (tool === "execute") return true;
  const task =
    tool === "app_connection_status" ? "inspect" : tool === "app_invite_member" ? "invite" : null;
  if (!task) return false;
  return scopes.some(
    (s) =>
      s.startsWith("mcp:" + task + ":") &&
      (app === undefined ||
        (typeof app === "string" && s === "mcp:" + task + ":" + encodeURIComponent(app))),
  );
}

export function selectedJobScopes(job: unknown, selection: unknown[], apps: { id: string }[]) {
  if (job !== "inspect" && job !== "invite") return null;
  const ids = [...new Set(selection)];
  if (
    !ids.length ||
    ids.length > 32 ||
    !ids.every((id): id is string => typeof id === "string" && apps.some((a) => a.id === id))
  )
    return null;
  return ids.map((id) => "mcp:" + job + ":" + encodeURIComponent(id));
}

const permissionNames: Record<string, string> = {
  admin: "Administer this identity server",
  mcp: "Administer this identity server",
  read: "Read admin data",
  "mcp:read": "Read admin data",
  openid: "Know who you are",
  profile: "See your name",
  email: "See your email address",
  groups: "See your groups",
  offline_access: "Stay connected until disconnected",
};
export function permissionSummary(scope: string, apps: { id: string; name: string }[]) {
  return scope
    .split(" ")
    .filter(Boolean)
    .map((s) => {
      if (!jobScope(s)) return permissionNames[s] ?? "Unrecognized permission";
      const [, job, encoded] = s.split(":");
      const app = apps.find((a) => encodeURIComponent(a.id) === encoded);
      return (
        (job === "invite" ? "Invite existing members to " : "Inspect connection health for ") +
        (app?.name ?? "a removed app")
      );
    })
    .join(" · ");
}
