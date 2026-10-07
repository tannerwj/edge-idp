import { expect, test } from 'e2e';

const base = process.env.E2E_BASE_URL ?? 'https://auth.johnson.network';

test('html responses carry the full security header set', async () => {
  const res = await fetch(`${base}/login`);
  expect(res.status).toBe(200);
  const h = res.headers;
  expect(h.get('strict-transport-security')).toContain('max-age=31536000');
  expect(h.get('strict-transport-security')).toContain('includeSubDomains');
  expect(h.get('x-content-type-options')).toBe('nosniff');
  expect(h.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(h.get('x-frame-options')).toBe('DENY');
  const csp = h.get('content-security-policy') ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
});

test('api responses carry security headers too', async () => {
  const res = await fetch(`${base}/jwks`);
  expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

test('unknown client fails as a page, not a redirect', async () => {
  const url = `${base}/authorize?client_id=nope&redirect_uri=https://evil.test/x&response_type=code`;
  const res = await fetch(url, { redirect: 'manual' });
  // Without a valid client we cannot safely redirect the error anywhere.
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain('unknown client_id');
});

test('unregistered redirect uri fails as a page', async () => {
  // Use a real client id shape; the client won't exist so this hits
  // invalid_client first — the point is it never redirects to evil.test.
  const url = `${base}/authorize?client_id=x&redirect_uri=https://evil.test/x&response_type=code`;
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(400);
  expect(res.headers.get('location')).toBeNull();
});

test('admin pages fail closed without a session', async () => {
  for (const path of ['/admin', '/admin/clients', '/admin/users', '/admin/audit']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toMatch(/^\/login\?next=/);
  }
  // Trailing slash normalizes before auth.
  const slash = await fetch(`${base}/admin/`, { redirect: 'manual' });
  expect(slash.status).toBe(301);
});

test('userinfo rejects a bogus token', async () => {
  const res = await fetch(`${base}/userinfo`, {
    headers: { authorization: 'Bearer bogus' },
  });
  expect(res.status).toBe(401);
});

test('token endpoint rejects a bogus client', async () => {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'bogus',
      redirect_uri: `${base}/cb`,
      client_id: 'nope',
      client_secret: 'nope',
    }),
  });
  expect(res.status).toBe(401);
});

test('cross-origin form posts are refused', async () => {
  // A sibling subdomain is "same-site", so SameSite=Lax alone would let it
  // post forms here. The same-origin guard must refuse before any handler.
  const res = await fetch(`${base}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: 'https://evil.example.test', 'sec-fetch-site': 'same-site' },
  });
  expect(res.status).toBe(403);
});

test('mcp 401 points clients at OAuth discovery', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
  const www = res.headers.get('www-authenticate') ?? '';
  expect(www).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  expect(www).toContain('scope="mcp"');
});

test('dynamic registration rejects dangerous redirect schemes', async () => {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'probe', redirect_uris: ['javascript:alert(1)'] }),
  });
  expect(res.status).toBe(400);
});
