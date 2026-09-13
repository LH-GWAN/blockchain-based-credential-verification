import { defineConfig } from '@playwright/test';

/** 전제: make demo (또는 scripts/demo.sh) 로 체인·서비스·앱이 떠 있음. 포트는 환경변수로 조정. */
export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
