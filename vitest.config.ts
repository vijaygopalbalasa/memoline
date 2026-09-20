import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    // apps/web starts an in-memory PGlite (WASM Postgres) per test file and runs every
    // migration in each one. Unbounded parallelism thrashes CPU and pushes unrelated
    // queries past their timeout, so cap the workers for the whole run.
    poolOptions: { forks: { maxForks: 3, minForks: 1 } },
  },
});
