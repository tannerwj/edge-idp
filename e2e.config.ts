import type { E2EConfig } from 'e2e';

export default {
  tests: 'tests/smoke/**/*.e2e.ts',
  targets: [{ name: 'api', platform: 'node' }],
} satisfies E2EConfig;
