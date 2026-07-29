import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: [
    process.env.CI ? ['dot'] : ['list'],
    [
      '@argos-ci/playwright/reporter',
      {
        buildName: 'local-model-gateway-dashboard',
        uploadToArgos: Boolean(process.env.CI),
      },
    ],
  ],
  use: {
    browserName: 'chromium',
    colorScheme: 'dark',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    launchOptions: {
      args: ['--disable-lcd-text', '--font-render-hinting=none'],
    },
  },
});
