import { describe, expect, it } from "vitest";
import { emailKey, timingSafeEqualHex } from "../src/util";
import { newerVersion } from "../src/upstream";
import { parseBulk } from "../src/invites";
import { parseBackup } from "../src/backup";
import { claimsForClient, resolveAccess } from "../src/access";
import type { Grant } from "../src/access";

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

describe("parseBulk", () => {
  it("reads Name <email>, email-then-name and name-then-email lines", () => {
    const { people, errors } = parseBulk(
      "Ada Lovelace <ada@example.com>\ngrace@example.com, Grace Hopper\nAlan Turing; alan@example.com",
    );
    expect(errors).toEqual([]);
    expect(people).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
      { name: "Grace Hopper", email: "grace@example.com" },
      { name: "Alan Turing", email: "alan@example.com" },
    ]);
  });

  it("derives a name from a bare address and strips quotes", () => {
    expect(parseBulk('mary.ann_smith@example.com\n"Bob" <bob@example.com>').people).toEqual([
      { name: "mary ann smith", email: "mary.ann_smith@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ]);
  });

  it("reports a line with no address instead of inviting a name", () => {
    const { people, errors } = parseBulk("\n  \nJust A Name\n");
    expect(people).toEqual([]);
    expect(errors).toEqual(['No email address in "Just A Name"']);
  });

  it("refuses more than 50 people at once", () => {
    const lines = Array.from({ length: 51 }, (_, i) => `p${i}@example.com`).join("\n");
    expect(() => parseBulk(lines)).toThrow("at most 50");
  });
});

const backupDoc = (tables: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "edge-idp-backup", version: 1, tables, ...extra });

describe("parseBackup", () => {
  const doc = backupDoc;

  it("refuses anything that isn't a version 1 edge-idp backup", () => {
    expect(() => parseBackup("not json")).toThrow("isn't JSON");
    expect(() => parseBackup(JSON.stringify({ format: "other", version: 1, tables: {} }))).toThrow(
      "isn't an edge-idp backup",
    );
    expect(() => parseBackup(doc({}, { version: 2 }))).toThrow("newer version");
    expect(() => parseBackup(JSON.stringify({ format: "edge-idp-backup", version: 1 }))).toThrow(
      "no tables",
    );
  });

  it("refuses column names that aren't plain identifiers", () => {
    expect(() => parseBackup(doc({ groups: [{ "id) VALUES (1); --": "x" }] }))).toThrow(
      "groups table is malformed",
    );
  });

  it("refuses nested values other than base64url blobs", () => {
    expect(() => parseBackup(doc({ users: [{ id: "u", extra: { a: 1 } }] }))).toThrow(
      "users table is malformed",
    );
    expect(() =>
      parseBackup(doc({ webauthn_credentials: [{ id: "c", public_key: { $b64: "a+b/" } }] })),
    ).toThrow("webauthn_credentials table is malformed");
  });

  it("keeps known tables, defaults missing ones to empty, and ignores unknown ones", () => {
    const b = parseBackup(
      doc(
        { groups: [{ id: "g", name: "family", created_at: 1 }], sessions: [{ id_hash: "x" }] },
        { issuer: "https://id.example.com", rp_id: "id.example.com" },
      ),
    );
    expect(b.tables.groups).toEqual([{ id: "g", name: "family", created_at: 1 }]);
    expect(b.tables.users).toEqual([]);
    expect(Object.keys(b.tables)).not.toContain("sessions");
    expect(b.rp_id).toBe("id.example.com");
  });
});
