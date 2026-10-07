import { describe, expect, it } from "vitest";
import { base64url, emailKey, rpIdFromIssuer, sha256Hex, timingSafeEqualHex } from "../src/util";
import { newerVersion } from "../src/upstream";

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
});

describe("newerVersion", () => {
  // Expected values by hand from semver ordering of MAJOR.MINOR.PATCH.
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
