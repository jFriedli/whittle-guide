/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// When deployed to GitHub Pages the site lives at https://<user>.github.io/<repo>/.
// The workflow passes the repo name in via BASE_PATH; local dev uses '/'.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2020',
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
