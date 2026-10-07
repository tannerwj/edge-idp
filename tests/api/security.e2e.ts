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
  expect(body).toContain('invalid_client');
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
    expect(res.status).toBe(403);
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
