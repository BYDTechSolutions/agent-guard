import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Lets the examples import the package by name while testing the source.
    alias: { '@bydtech/agent-guard': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
