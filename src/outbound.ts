import { isLocalIssuer } from "./config";

function publicHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return false;
  return host.includes(".");
}

function loopback(u: URL): boolean {
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export function outboundUrlProblem(raw: string, issuer: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Enter a full URL, starting with https://.";
  }
  if (u.username || u.password) return "Leave credentials out of the URL.";
  if (isLocalIssuer(issuer) && loopback(u)) return null;
  if (u.protocol !== "https:") return "Use an https:// URL.";
  if (!publicHost(u.hostname)) return "Use a public hostname, not an IP address or localhost.";
  return null;
}

export async function postOutbound(
  url: string,
  init: { body: string; headers: Record<string, string> },
): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "POST",
      body: init.body,
      headers: { "user-agent": "edge-idp", ...init.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
    return res.ok ? `${res.status}` : `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 120) : "failed";
  }
}
