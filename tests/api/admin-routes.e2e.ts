import { expect, test } from 'e2e';

const base = process.env.E2E_BASE_URL ?? 'https://auth.johnson.network';

test('trailing slashes redirect to the canonical path', async () => {
  // /admin/ must not 404 — it redirects to /admin.
  const res = await fetch(`${base}/admin/`, { redirect: 'manual' });
  expect(res.status).toBe(301);
  const loc = res.headers.get('location') ?? '';
  expect(loc).toMatch(/\/admin$/);
});

test('admin routes exist (403 for anonymous, not 404)', async () => {
  // If these 404'd, the route is broken. 403 means the route exists and
  // the auth middleware correctly rejected the anonymous request.
  for (const path of ['/admin', '/admin/users', '/admin/groups', '/admin/clients', '/admin/audit', '/admin/theme']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    expect(res.status).toBe(403);
  }
});

test('theme CSS URLs carry a cache-busting hash', async () => {
  const res = await fetch(`${base}/login`);
  const html = await res.text();
  // The stylesheet link must include ?v=<hash> so deploys bust the cache.
  expect(html).toMatch(/\/themes\/\w+\.css\?v=[a-z0-9]+/);
});

test('theme CSS is served with long cache headers', async () => {
  const res = await fetch(`${base}/themes/obsidian.css`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/css');
  expect(res.headers.get('cache-control')).toContain('max-age=3600');
});

test('unknown theme returns 404', async () => {
  const res = await fetch(`${base}/themes/nope.css`);
  expect(res.status).toBe(404);
});
