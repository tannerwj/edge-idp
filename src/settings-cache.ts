import { getSetting } from "./db";
import type { Env } from "./config";

export const ACCENTS = [
  "indigo",
  "iris",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "graphite",
] as const;

let cache: { value: string; at: number } | null = null;

export async function getAccent(env: Env): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache.value;
  const raw = await getSetting(env.DB, "accent", "indigo");
  const value = (ACCENTS as readonly string[]).includes(raw) ? raw : "indigo";
  cache = { value, at: now };
  return value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
