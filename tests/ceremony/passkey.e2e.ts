// Passkey ceremony tests — deterministic, no model. Uses Playwright directly
// (via the shared Chromium on :9222) for CDP virtual-authenticator control,
// which the framework's `browser` fixture does not expose. Runs against the
// live deployment; seeds and cleans up a throwaway user via wrangler.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { expect as pwExpect } from 'playwright/test';
import { expect, test } from 'e2e';

const base = process.env.E2E_BASE_URL ?? 'https://auth.johnson.network';
const CDP = 'http://127.0.0.1:9222';

function wrangler(args: string[]): void {
  execFileSync('npx', ['wrangler', ...args], {
    cwd: process.env.HOME + '/workspace/identity',
    stdio: 'pipe',
    env: { ...process.env },
  });
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface Seed {
  userId: string;
  email: string;
  token: string;
}

function seedUser(): Seed {
  const userId = randomUUID();
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const token = randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  wrangler(['d1', 'execute', 'identity', '--remote', '--command',
    `INSERT INTO users (id, created_at, name, email, is_admin, updated_at) VALUES ('${userId}', ${now}, 'E2E Test', '${email}', 0, ${now});` +
    `INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES ('${sha256Hex(token)}', '${userId}', ${now}, ${now + 3600});`,
  ]);
  return { userId, email, token };
}

function dropUser(userId: string): void {
  wrangler(['d1', 'execute', 'identity', '--remote', '--command',
    `DELETE FROM users WHERE id = '${userId}';`]);
}

async function addAuthenticator(cdp: CDPSession, autoPresence: boolean): Promise<string> {
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: autoPresence,
    },
  });
  return authenticatorId as string;
}

async function setPresence(cdp: CDPSession, id: string, enabled: boolean): Promise<void> {
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: id,
    enabled,
  });
}

test.describe('passkey ceremonies', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP(CDP);
  });

  test.afterAll(async () => {
    await browser.close();
  });

  test('enrollment creates a passkey and signs the user in', async () => {
    const seed = seedUser();
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page: Page = await ctx.newPage();
      const cdp: CDPSession = await ctx.newCDPSession(page);
      const authId = await addAuthenticator(cdp, false);

      await page.goto(`${base}/enroll/${seed.token}`, { waitUntil: 'networkidle' });
      await pwExpect(page.getByText('E2E Test').first()).toBeVisible();

      await setPresence(cdp, authId, true);
      await page.locator('#enroll-btn').click();
      await page.waitForURL(`${base}/account`, { timeout: 30_000 });
      await setPresence(cdp, authId, false);

      const body = (await page.content()) ?? '';
      expect(body.includes('Synced passkey') || body.includes('Device passkey')).toBe(true);
    } finally {
      await ctx.close();
      dropUser(seed.userId);
    }
  });

  test('button sign-in works with an explicit email', async () => {
    const seed = seedUser();
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page: Page = await ctx.newPage();
      const cdp: CDPSession = await ctx.newCDPSession(page);
      const authId = await addAuthenticator(cdp, false);

      // Enroll first.
      await page.goto(`${base}/enroll/${seed.token}`, { waitUntil: 'networkidle' });
      await setPresence(cdp, authId, true);
      await page.locator('#enroll-btn').click();
      await page.waitForURL(`${base}/account`, { timeout: 30_000 });
      await setPresence(cdp, authId, false);

      // Sign out.
      await page.locator('form[action="/logout"] button').click();
      await page.waitForURL(`${base}/login`, { timeout: 15_000 });

      // Sign back in with the button. The conditional request hangs (no
      // auto-presence), so the explicit flow must carry the login.
      await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
      await page.locator('#email').fill(seed.email);
      await setPresence(cdp, authId, true);
      await page.locator('#passkey-btn').click();
      await page.waitForURL(`${base}/account`, { timeout: 30_000 });
      await setPresence(cdp, authId, false);

      expect(page.url().replace(/\/$/, '')).toBe(`${base}/account`);
      expect((await page.content()).includes(seed.email)).toBe(true);
    } finally {
      await ctx.close();
      dropUser(seed.userId);
    }
  });

  test('conditional mediation auto-signs-in on page load', async () => {
    const seed = seedUser();
    const ctx: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page: Page = await ctx.newPage();
      const cdp: CDPSession = await ctx.newCDPSession(page);
      // Auto-presence: the virtual authenticator completes the autofill
      // ceremony without user interaction (real users pick from the dropdown).
      await addAuthenticator(cdp, true);

      await page.goto(`${base}/enroll/${seed.token}`, { waitUntil: 'networkidle' });
      await page.locator('#enroll-btn').click();
      await page.waitForURL(`${base}/account`, { timeout: 30_000 });

      await page.locator('form[action="/logout"] button').click();
      await page.waitForURL(`${base}/login`, { timeout: 15_000 });

      await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
      await page.waitForURL(`${base}/account`, { timeout: 15_000 });
      expect(page.url().replace(/\/$/, '')).toBe(`${base}/account`);
    } finally {
      await ctx.close();
      dropUser(seed.userId);
    }
  });
});
