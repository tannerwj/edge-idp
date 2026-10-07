const configured = process.env.E2E_BASE_URL;
if (!configured) throw new Error('E2E_BASE_URL is required (use npm run smoke)');
export const base: string = configured;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  const parsed: unknown = await res.json();
  return { status: res.status, body: isRecord(parsed) ? parsed : {} };
}

export function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}
