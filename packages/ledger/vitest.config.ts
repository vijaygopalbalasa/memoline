import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ledger',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
