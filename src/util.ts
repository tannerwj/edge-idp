/** Small pure helpers. No I/O, no secrets, no crypto agility decisions here. */

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function newId(): string {
  return crypto.randomUUID();
}

/** URL-safe random token (for session ids, codes, secrets). */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64url(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(
  data: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time hex string comparison for secret hashes.
 * Threat note: plain `===` on hashes leaks prefix information through timing;
 * every secret comparison in this codebase goes through here.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** WebAuthn RP ID must be the registrable domain of the issuer origin. */
export function rpIdFromIssuer(issuer: string): string {
  return new URL(issuer).hostname;
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}
