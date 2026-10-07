import { expect, test } from 'e2e';

const base = process.env.E2E_BASE_URL ?? 'https://auth.johnson.network';

// Code mode tests require a valid API token. Set E2E_MCP_TOKEN to run them;
// they are skipped otherwise (no production writes).
const token = process.env.E2E_MCP_TOKEN;
const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

async function rpc(method: string, params?: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() as any };
}

test('mcp rejects unauthenticated requests', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
});

test('mcp rejects invalid token without spinning up sandbox', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'execute', arguments: { code: 'return 1;' } },
    }),
  });
  expect(res.status).toBe(401);
});

(token ? test : test.skip)('execute lists execute and metrics_summary tools', async () => {
  const { body } = await rpc('tools/list');
  const names = body.result.tools.map((t: any) => t.name);
  expect(names).toContain('execute');
  expect(names).toContain('metrics_summary');
});

(token ? test : test.skip)('execute runs a chain and returns only the final value', async () => {
  const { body } = await rpc('tools/call', {
    name: 'execute',
    arguments: { code: 'const u = await id.users_list({}); return u.length;' },
  });
  const text = body.result.content[0].text;
  const parsed = JSON.parse(text);
  expect(typeof parsed.value).toBe('number');
  expect(parsed.toolCalls.length).toBeGreaterThan(0);
  expect(parsed.toolCalls[0].tool).toBe('users_list');
});

(token ? test : test.skip)('sandbox has no network access', async () => {
  const { body } = await rpc('tools/call', {
    name: 'execute',
    arguments: {
      code: 'try { await fetch("https://example.com"); return "open"; } catch (e) { return "blocked"; }',
    },
  });
  const parsed = JSON.parse(body.result.content[0].text);
  expect(parsed.value).toBe('blocked');
});

(token ? test : test.skip)('execute cannot call execute (no recursion)', async () => {
  const { body } = await rpc('tools/call', {
    name: 'execute',
    arguments: { code: 'return await id.execute({ code: "1" });' },
  });
  const text = body.result.content[0].text;
  expect(text).toContain('not available inside execute');
});

(token ? test : test.skip)('metrics_summary returns per-tool stats', async () => {
  const { body } = await rpc('tools/call', {
    name: 'metrics_summary', arguments: {},
  });
  const parsed = JSON.parse(body.result.content[0].text);
  expect(parsed.window).toBe('last 24h');
  expect(Array.isArray(parsed.per_tool)).toBe(true);
});
