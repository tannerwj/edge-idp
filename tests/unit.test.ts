import { describe, expect, it } from "vitest";
import { base64url, emailKey, rpIdFromIssuer, sha256Hex, timingSafeEqualHex } from "../src/util";
import { newerVersion } from "../src/upstream";
import { claimsForClient, resolveAccess } from "../src/access";
import type { Grant } from "../src/access";

describe("base64url", () => {
  it("encodes without padding or url-unsafe chars", () => {
    const out = base64url(new Uint8Array([251, 255, 190, 0, 1]));
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(out).not.toContain("=");
  });

  it("round-trips through atob", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255]);
    const s = base64url(bytes);
    const back = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    expect([...back]).toEqual([...bytes]);
  });
});

describe("sha256Hex", () => {
  it("matches the known vector", async () => {
    expect(await sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("accepts Uint8Array input identically", async () => {
    const a = await sha256Hex("hello");
    const b = await sha256Hex(new TextEncoder().encode("hello"));
    expect(a).toBe(b);
  });
});

describe("timingSafeEqualHex", () => {
  it("accepts equal strings", () => {
    expect(timingSafeEqualHex("abc123", "abc123")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(timingSafeEqualHex("abc123", "abc124")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false);
  });
});

describe("rpIdFromIssuer", () => {
  it("extracts the hostname", () => {
    expect(rpIdFromIssuer("https://auth.example.com")).toBe("auth.example.com");
  });

  it("ignores ports and paths", () => {
    expect(rpIdFromIssuer("https://auth.example.com:8443/x")).toBe("auth.example.com");
  });
});

describe("emailKey", () => {
  it("lowercases and trims", () => {
    expect(emailKey("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("folds only ASCII, like SQLite lower(), so the stored address always matches", () => {
    expect(emailKey(" Émile@Example.com ")).toBe("Émile@example.com");
    expect(emailKey("ÖSTEN@EXAMPLE.SE")).toBe("Östen@example.se");
  });
});

describe("newerVersion", () => {
  it("compares numerically, not lexically", () => {
    expect(newerVersion("2.10.0", "2.9.9")).toBe(true);
    expect(newerVersion("2.9.9", "2.10.0")).toBe(false);
  });

  it("orders major, then minor, then patch", () => {
    expect(newerVersion("3.0.0", "2.99.99")).toBe(true);
    expect(newerVersion("2.1.1", "2.1.0")).toBe(true);
    expect(newerVersion("2.1.0", "2.1.1")).toBe(false);
  });

  it("equal versions are not newer", () => {
    expect(newerVersion("2.1.0", "2.1.0")).toBe(false);
  });

  it("ignores pre-release / build suffixes", () => {
    expect(newerVersion("2.2.0-beta.1", "2.1.0")).toBe(true);
    expect(newerVersion("2.1.0+build.5", "2.1.0")).toBe(false);
  });

  it("never claims an update from garbage", () => {
    expect(newerVersion("", "2.1.0")).toBe(false);
    expect(newerVersion("latest", "2.1.0")).toBe(false);
    expect(newerVersion("2.1", "2.0.0")).toBe(false);
    expect(newerVersion("9.9.9", "not-a-version")).toBe(false);
  });
});

function grant(g: Partial<Grant>): Grant {
  return {
    id: "g",
    app_id: null,
    app_group_id: null,
    user_id: null,
    group_id: null,
    everyone: 0,
    role: null,
    created_at: 0,
    ...g,
  };
}

describe("resolveAccess", () => {
  const solar = { id: "solar", app_group_id: "home", slug: "solar" };
  const nas = { id: "nas", app_group_id: null, slug: "nas" };
  const me = { userId: "u1", groupIds: ["family"], isPublic: false };
  const stranger = { userId: "p1", groupIds: ["public"], isPublic: true };

  it("does not let an everyone grant reach a public (self-registered) account", () => {
    const grants = [
      grant({ app_id: "nas", everyone: 1 }),
      grant({ app_group_id: "home", everyone: 1 }),
    ];
    expect(resolveAccess([solar, nas], grants, stranger).size).toBe(0);
  });

  it("lets a public account in only through a grant that names it or its group", () => {
    const grants = [
      grant({ app_id: "nas", everyone: 1 }),
      grant({ app_id: "solar", group_id: "public", role: "player" }),
    ];
    const access = resolveAccess([solar, nas], grants, stranger);
    expect([...access.entries()]).toEqual([["solar", ["player"]]]);
  });

  it("ignores grants for another user or a group the user is not in", () => {
    const grants = [
      grant({ app_id: "solar", user_id: "u2" }),
      grant({ app_id: "solar", group_id: "friends" }),
    ];
    expect(resolveAccess([solar], grants, me).size).toBe(0);
  });

  it("does not let an app-group grant reach an ungrouped app", () => {
    const grants = [grant({ app_group_id: "home", everyone: 1 })];
    const access = resolveAccess([solar, nas], grants, me);
    expect([...access.keys()]).toEqual(["solar"]);
  });

  it("does not match an ungrouped app to a grant with no target", () => {
    expect(resolveAccess([nas], [grant({ everyone: 1 })], me).size).toBe(0);
  });

  it("grants access without a role and unions roles across user, group and app-group grants", () => {
    const grants = [
      grant({ app_id: "nas", everyone: 1 }),
      grant({ app_id: "solar", user_id: "u1", role: "writer" }),
      grant({ app_group_id: "home", group_id: "family", role: "reader" }),
      grant({ app_group_id: "home", group_id: "family", role: "writer" }),
    ];
    const access = resolveAccess([solar, nas], grants, me);
    expect(access.get("nas")).toEqual([]);
    expect(access.get("solar")).toEqual(["reader", "writer"]);
  });
});

describe("claimsForClient", () => {
  const apps = [
    { id: "grafana", slug: "grafana", client_id: "c-grafana" },
    { id: "nas", slug: "nas", client_id: null },
    { id: "legacy", slug: null, client_id: null },
  ];
  const access = new Map([
    ["grafana", ["writer"]],
    ["nas", ["admin"]],
    ["legacy", ["admin"]],
  ]);

  it("never gives a linked client another app's roles or the app inventory", () => {
    expect(claimsForClient(apps, access, "c-grafana")).toEqual({ roles: ["writer"] });
  });

  it("gives a linked client an empty role list when the user has access but no role", () => {
    const noRole = new Map([["grafana", []]]);
    expect(claimsForClient(apps, noRole, "c-grafana")).toEqual({ roles: [] });
  });

  it("gives an unlinked client the sorted app list without roles, skipping slugless apps", () => {
    expect(claimsForClient(apps, access, "c-access")).toEqual({ apps: ["grafana", "nas"] });
  });
});
