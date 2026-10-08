import { defineConfig } from '@playwright/test';

// The e2e suite runs against the production build in dist/ (service worker
// included), served by tests/e2e/server.ts under the GitHub Pages base path.
// Build first: BASE_PATH=/PocketTeX/ npm run build

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'allow',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
});
