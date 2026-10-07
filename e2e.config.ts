import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// Live deployment target. No `command` (the app is already deployed) and no
// `agents` section: every test here is deterministic, so no model is needed.
// The `api` target has no engine; tests read the URL from E2E_BASE_URL.
// The `chromium` target drives the live site through the shared in-sandbox
// Chromium on :9222 (see ~/workspace/e2e-infra).
const baseUrl = process.env.E2E_BASE_URL ?? 'https://auth.johnson.network';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    { name: 'api', platform: 'node' },
    {
      name: 'chromium',
      engine: web({ connect: { cdpEndpoint: () => 'http://127.0.0.1:9222' } }),
      app: { url: baseUrl },
    },
  ],
} satisfies E2EConfig;
