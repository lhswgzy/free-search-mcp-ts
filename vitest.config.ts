import { defineConfig } from 'vitest/config';

/**
 * The source uses NodeNext-style `.js` specifiers inside TypeScript files
 * (`import { x } from './util/url.js'`), which is what `tsc` needs to emit
 * correct ESM. Vite has to be told to look for the `.ts` file behind that
 * specifier, otherwise every relative import in a test fails to resolve.
 */
export default defineConfig({
  resolve: {
    extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The engine fixtures are read from disk and a few tests write to a temp
    // data directory; keeping files sequential avoids surprising SQLite locks
    // on Windows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
