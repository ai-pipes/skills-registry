import { defineConfig, devices } from '@playwright/test';

const browsers = {
  chromium: devices['Desktop Chrome'],
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
};

// Browser tests against the built image (scripts/e2e-image.sh starts it and sets E2E_BASE_URL).
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../node_modules/.cache/playwright/test-results',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:38081',
    trace: 'retain-on-failure',
  },
  // E2E_BROWSERS=chromium,firefox,webkit runs the same specs in more engines.
  projects: (process.env['E2E_BROWSERS'] ?? 'chromium')
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is keyof typeof browsers => name in browsers)
    .map((name) => ({ name, use: browsers[name] })),
});
