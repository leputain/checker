import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 40_000,
  expect: { timeout: 8_000 },
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:3101',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'webkit-ipad-portrait',
      use: { ...devices['iPad Pro 11'], browserName: 'webkit' },
    },
    {
      name: 'webkit-ipad-landscape',
      use: { ...devices['iPad Pro 11 landscape'], browserName: 'webkit' },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 3101',
    url: 'http://localhost:3101/api/health/ready',
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      CANDIDATE_CHECK_STATE_PATH: '.wrangler/e2e',
      CANDIDATE_CHECK_SKIP_TELEGRAM_FILE: '1',
      CANDIDATE_CHECK_ADMIN_PIN_FILE: '.data/e2e-admin-pin.txt',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
      TELEGRAM_CONFIG_STATUS: 'missing',
      TELEGRAM_ENABLED: '1',
      TELEGRAM_REQUIRED: '0',
    },
  },
});
