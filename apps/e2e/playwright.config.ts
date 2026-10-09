import { defineConfig } from '@playwright/test';

/** 전제: make demo (또는 scripts/demo.sh) 로 체인·서비스·앱이 떠 있음. 포트는 환경변수로 조정.
 *  ⑦(발급기관 정지)은 E2E_ISSUER_DOWN_CMD 를 줄 때만 실행되고, 없으면 리포트에 skipped 로 남는다. */
export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // results.json: scripts/make_report.py 가 test 별 결과(⑦ 실행·skipped 여부)를 읽는다
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
