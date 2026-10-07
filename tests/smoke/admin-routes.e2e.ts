import { expect, test } from 'e2e';
import { base } from './http';

test('trailing slashes redirect to the canonical path', async () => {
  // /admin/ must not 404 — it redirects to /admin.
  const res = await fetch(`${base}/admin/`, { redirect: 'manual' });
  expect(res.status).toBe(301);
  const loc = res.headers.get('location') ?? '';
  expect(loc).toMatch(/\/admin$/);
});

test('admin routes exist and send anonymous visitors to sign in', async () => {
  // A 404 would mean the route is broken. Anonymous requests are bounced to
  // /login with a same-origin `next`, so admin content never renders.
  for (const path of ['/admin', '/admin/users', '/admin/groups', '/admin/apps', '/admin/clients', '/admin/audit', '/admin/connect', '/admin/settings']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toBe(`/login?next=${encodeURIComponent(path)}`);
  }
});

test('static asset URLs carry a content hash', async () => {
  const res = await fetch(`${base}/login`);
  const html = await res.text();
  // ?v=<content hash> so every deploy busts caches.
  expect(html).toMatch(/\/app\.css\?v=[a-f0-9]{10}/);
  expect(html).toMatch(/\/app\.js\?v=[a-f0-9]{10}/);
});

test('static assets are immutable-cached with the right types', async () => {
  const css = await fetch(`${base}/app.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get('content-type')).toContain('text/css');
  expect(css.headers.get('cache-control')).toContain('immutable');
  const js = await fetch(`${base}/app.js`);
  expect(js.headers.get('content-type')).toContain('text/javascript');
});

test('html pages are never cached', async () => {
  const res = await fetch(`${base}/login`);
  expect(res.headers.get('cache-control')).toBe('no-store');
});
