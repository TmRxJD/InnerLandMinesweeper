import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts (whose root is the dev host) so tests are discovered from
// the repo root across src/**, not just under src/dev.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
