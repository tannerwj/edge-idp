/**
 * Instance-wide theme cache. The theme changes rarely (admin-only action),
 * so we cache it in the worker isolate for 60s to avoid a D1 roundtrip on
 * every page load.
 */
import { getSetting } from "./db";
import type { Env } from "./config";

let cache: { value: string; at: number } | null = null;

export async function getTheme(env: Env): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache.value;
  const value = await getSetting(env.DB, "theme", "obsidian");
  cache = { value, at: now };
  return value;
}

export function invalidateThemeCache(): void {
  cache = null;
}
