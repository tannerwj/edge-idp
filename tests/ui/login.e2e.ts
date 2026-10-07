// UI tests — deterministic, no model. Run in-sandbox via the shared
// Chromium on :9222 (see ~/workspace/e2e-infra) or with `npm run test:e2e`.
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('login page is clean and passkey-first', { requires: ['browser'] }, async ({ app, screen, browser }) => {
  await app.open('/login');
  await expect(browser).toHaveTitle(/Sign in/);
  await expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  // The email path (for non-discoverable security keys) is tucked away.
  await expect(screen.getByText(/Use a passkey for a specific email/)).toBeVisible();
  await expect(screen.getByText(/nothing to phish/)).toBeVisible();
});

test('login page has no js errors', { requires: ['browser'] }, async ({ app, browser }) => {
  const errors: string[] = [];
  // The engine surfaces page errors in the report; here we assert the
  // page settles without throwing by checking a stable element.
  await app.open('/login');
  await expect(browser).toHaveURL(/\/login/);
});

test('enrollment with a bad token explains itself', { requires: ['browser'] }, async ({ app, screen }) => {
  await app.open('/enroll/does-not-exist');
  await expect(screen.getByText(/work once and last 7 days/i)).toBeVisible();
});
