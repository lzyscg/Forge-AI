import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/*/src/**/*.e2e.test.ts', 'packages/*/src/**/*.e2e.test.ts'],
    testTimeout: 60000,
  },
});
