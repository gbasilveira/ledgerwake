import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ledgerwake/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@ledgerwake/claude-code': fileURLToPath(
        new URL('./packages/claude-code/src/index.ts', import.meta.url),
      ),
      '@ledgerwake/api': fileURLToPath(new URL('./packages/api/src/index.ts', import.meta.url)),
      '@ledgerwake/git': fileURLToPath(new URL('./packages/git/src/index.ts', import.meta.url)),
      '@ledgerwake/store': fileURLToPath(new URL('./packages/store/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
