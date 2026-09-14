/**
 * 시연 ①~⑤ 자동 재현 (docs/DEMO.md). 스크린샷은 docs/screenshots/ 에 저장한다.
 *  ① 지갑 생성·증명서 발급  ② AI 혜택 추천  ③ QR(코드) 제출  ④ 기관 검증 PASS
 *  ⑤ 폐기 후 차단 + 공격 시연 4종
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const WALLET = process.env.WALLET_URL ?? 'http://localhost:3010';
const VERIFIER_APP = process.env.VERIFIER_APP_URL ?? 'http://localhost:3001';
const ISSUER_DAEGU = process.env.ISSUER_DAEGU_URL ?? 'http://localhost:8001';
const ISSUER_WELFARE = process.env.ISSUER_WELFARE_URL ?? 'http://localhost:8003';
const SHOTS = join(process.cwd(), '..', '..', 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function newContexts(browser: Browser) {
  const wallet = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ko-KR' })).newPage();
  const verifier = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ko-KR' })).newPage();
  return { wallet, verifier };
}

async function createVerifierRequest(verifier: Page, preset?: string, verifierName?: string): Promise<string> {
  await verifier.goto(`${VERIFIER_APP}/`);
  if (verifierName) await verifier.getByRole('radio', { name: new RegExp(verifierName) }).check();
  if (preset) await verifier.getByRole('button', { name: preset }).first().click();
  await verifier.getByRole('button', { name: '요청 QR 만들기' }).click();
  const codeEl = verifier.getByLabel(/^확인 코드/);
  await expect(codeEl).toBeVisible();
  const label = await codeEl.getAttribute('aria-label');
  const code = (label ?? '').replace(/\D/g, '');
  expect(code).toHaveLength(6);
  return code;
}

async function presentWithCode(wallet: Page, code: string) {
  await wallet.goto(`${WALLET}/present`);
  await wallet.locator('#code').fill(code);
  await wallet.getByRole('button', { name: '요청 불러오기' }).first().click();
  await expect(wallet.getByText('다음 정보를 요청했습니다').first()).toBeVisible();
  await expect(wallet.getByText('제공되지 않는 정보: 이름 · 주민등록번호 · 주소 · 소득 금액 · 계좌 정보')).toBeVisible();
}

test('①~⑤ 전체 시연 흐름', async ({ browser }) => {
  const { wallet, verifier } = await newContexts(browser);

  // ── ① 지갑 생성 → 사전 판정 → 동의 → 발급 ───────────────────────────────
  await wallet.goto(`${WALLET}/`);
  await expect(wallet.getByRole('button', { name: '내 지갑 만들기' })).toBeVisible();
  await expect(wallet.locator('select')).toHaveValue('C-001');
  await shot(wallet, '01-wallet-home');
  await wallet.getByRole('button', { name: '내 지갑 만들기' }).click();

  await wallet.waitForURL(/\/credentials/);
  await expect(wallet.getByText('규칙 버전 2026.1 · 해시 일치 ✓')).toBeVisible();
  await expect(wallet.getByText('이 판정은 내 휴대폰 안에서만 계산되었습니다 (개인정보 전송 없음)')).toBeVisible();
  await expect(wallet.getByText('발급 가능').first()).toBeVisible();
  await expect(wallet.getByText(/규칙 기준 미충족 — 기준 중위소득 32% 이하 여부/).first()).toBeVisible();
  // 신용평점은 창구가 자체 조회 — 증명서로 발급되지 않는다
  await expect(wallet.getByText(/신용평점 하위 20% 여부/).first()).toBeVisible();
  await shot(wallet, '02-wallet-precheck');
  await wallet.getByRole('button', { name: '증명서 받기' }).click();

  // 대구광역시 동의 화면 (고정 문구)
  await expect(wallet.getByText('대구광역시에 다음 증명서 발급을 요청합니다')).toBeVisible();
  await expect(wallet.getByText('증명서에 담기지 않는 정보: 이름 · 주민등록번호 · 주소 · 소득 금액')).toBeVisible();
  await shot(wallet, '03-wallet-consent-daegu');
  await wallet.getByRole('button', { name: '동의하고 발급받기' }).click();
  // 복지기관(사회보장정보원) 동의 화면 — 소득·수급 사실은 공공 복지기관이 발급한다
  await expect(wallet.getByText('사회보장정보원(복지기관)에 다음 증명서 발급을 요청합니다')).toBeVisible();
  await shot(wallet, '03b-wallet-consent-welfare');
  await wallet.getByRole('button', { name: '동의하고 발급받기' }).click();

  await expect(wallet.getByText('발급 완료').first()).toBeVisible();
  await expect(wallet.getByText('상태: 유효').first()).toBeVisible();
  const cardsText = await wallet.locator('main').innerText();
  expect(cardsText).not.toContain('1000000');
  expect(cardsText).not.toContain('1958-03-12');
  expect(cardsText).not.toContain('김복례');
  await shot(wallet, '04-wallet-credentials');

  // ── ② 창구 혜택 안내 (은행·민간 먼저, 공공 복지는 복지멤버십 안내 대상으로 짧게) ──
  await wallet.goto(`${WALLET}/benefits`);
  await expect(wallet.getByText(/은행·민간 창구 혜택/).first()).toBeVisible();
  await expect(wallet.getByText(/공공 복지/).first()).toBeVisible();
  await expect(wallet.getByText('지금은 해당되지 않는 혜택').first()).toBeVisible();
  await expect(wallet.getByText('햇살론뱅크').first()).toBeVisible({ timeout: 60_000 });
  await expect(wallet.getByText(/창구에 제출할 증명서/).first()).toBeVisible();
  await expect(wallet.getByText('근거 조항').first()).toBeVisible({ timeout: 60_000 });
  await shot(wallet, '05-wallet-benefits');
  await wallet.getByRole('button', { name: 'AI가 받은 정보 보기' }).click();
  await expect(wallet.getByText('원본 수치·이름 없음', { exact: false })).toBeVisible();
  const sheetText = await wallet.locator('main').innerText();
  expect(sheetText).not.toContain('1000000');
  expect(sheetText).not.toContain('monthlyIncomeKRW');
  await shot(wallet, '06-wallet-ai-payload');

  // ── ③ 검증 요청 → 코드 입력 → 동의하고 제출 ───────────────────────────────
  const code = await createVerifierRequest(verifier);
  await shot(verifier, '07-verifier-request');
  await presentWithCode(wallet, code);
  await expect(wallet.getByText('iM뱅크 칠성동지점', { exact: false }).first()).toBeVisible();
  await expect(wallet.getByText('(사회보장정보원(복지기관) 발급)', { exact: false }).first()).toBeVisible();
  await shot(wallet, '08-wallet-present-confirm');
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('자격 충족').first()).toBeVisible();
  await shot(wallet, '09-wallet-present-result');

  // ── ④ 기관 검증 결과 ──────────────────────────────────────────────────────
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 충족').first()).toBeVisible();
  await expect(verifier.getByText(/총 소요/).first()).toBeVisible();
  await expect(verifier.getByText('대구광역시').first()).toBeVisible();
  await expect(verifier.getByText('사회보장정보원(복지기관)').first()).toBeVisible();
  await expect(verifier.getByText('원장 트랜잭션').first()).toBeVisible();
  await expect(verifier.locator('main')).toContainText(/0x[0-9a-f]{64}/, { timeout: 40_000 }); // 영수증 txHash
  await shot(verifier, '10-verifier-result-pass');
  const verifierText = await verifier.locator('main').innerText();
  expect(verifierText).not.toContain('김복례');
  expect(verifierText).not.toContain('1000000');

  // ── ③' 햇살론뱅크 용도: 소득금액증명 원본 대신 '연소득 3,500만 원 이하 = 참' 1개 항목만 ──
  const code3 = await createVerifierRequest(verifier, '햇살론뱅크 대상 확인');
  await presentWithCode(wallet, code3);
  await expect(wallet.getByText('연소득 3,500만 원 이하 여부', { exact: false }).first()).toBeVisible();
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('자격 충족').first()).toBeVisible();
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 충족').first()).toBeVisible();
  await expect(verifier.getByText(/정책 판정 재현/).first()).toBeVisible();
  await shot(verifier, '10b-verifier-result-sunshine-bank');

  // ── ⑥ 조회형 대비 비교 패널 (§12.5): 숫자는 서비스(data/comparison.json)에서 온다 ──
  const panel = verifier.getByTestId('comparison-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('같은 상담, 두 경로 비교')).toBeVisible();
  await expect(panel.getByText('공공 마이데이터 방식 (조회형)')).toBeVisible();
  await expect(panel.getByText('대구 혜택패스 (보유형)')).toBeVisible();
  await expect(panel.getByText('소득금액증명', { exact: false }).first()).toBeVisible();
  await expect(verifier.getByTestId('comparison-summary')).toHaveText(/이번 검증에서 줄어든 항목: 10 → 1 \(90%\)/);
  await expect(panel.getByText(/3년 보관/)).toBeVisible();
  await expect(panel.getByText(/실제 API 호출 결과가 아니다/)).toBeVisible();
  const panelText = await panel.innerText();
  expect(panelText).not.toMatch(/유출(이)? ?불가|개인정보가 사라|종이 ?증명서를 ?없/);
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(SHOTS, '15-verifier-comparison.png') });
  // 모바일 폭에서 세로 스택(조회형이 먼저)
  const mobileVerifier = await (await verifier.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' })).newPage();
  await mobileVerifier.goto(verifier.url());
  const pullBox = await mobileVerifier.getByTestId('comparison-pull').boundingBox();
  const holdBox = await mobileVerifier.getByTestId('comparison-hold').boundingBox();
  expect(pullBox && holdBox && pullBox.y < holdBox.y && Math.abs(pullBox.x - holdBox.x) < 4).toBeTruthy();
  await mobileVerifier.getByTestId('comparison-panel').screenshot({ path: join(SHOTS, '15b-verifier-comparison-mobile.png') });
  await mobileVerifier.context().close();

  // ── ③' 재사용: 같은 카드, 다른 창구 (iM저축은행 + 새희망홀씨) — 재발급 없이 통과 (§2-8) ──
  const code4 = await createVerifierRequest(verifier, '새희망홀씨 대상 확인', 'iM저축은행');
  await presentWithCode(wallet, code4);
  await expect(wallet.getByText('iM저축은행', { exact: false }).first()).toBeVisible();
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('자격 충족').first()).toBeVisible();
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 충족').first()).toBeVisible();
  await expect(verifier.getByText('iM저축은행', { exact: false }).first()).toBeVisible();
  await shot(verifier, '10c-verifier-result-reuse-savings');
  // 발급기관에 새 발급이 없었음을 확인 (재발급 없이 재사용)
  const adminAfter = await (await fetch(`${ISSUER_WELFARE}/admin/credentials`)).json();
  expect(adminAfter.credentials.filter((c: { claim: string }) => c.claim === 'annualIncomeUnder35M')).toHaveLength(1);

  // ── ⑤ 폐기 → 재제출 차단 ──────────────────────────────────────────────────
  const admin = await (await fetch(`${ISSUER_WELFARE}/admin/credentials`)).json();
  const target = admin.credentials.find((c: { claim: string }) => c.claim === 'incomeBelow50Median');
  expect(target).toBeTruthy();
  const rv = await (await fetch(`${ISSUER_WELFARE}/admin/credentials/${target.jti}/revoke`, { method: 'POST' })).json();
  expect(rv.revoked).toBe(true);

  const code2 = await createVerifierRequest(verifier);
  await presentWithCode(wallet, code2);
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('제출 거부됨').first()).toBeVisible();
  await expect(wallet.getByText('폐기된 증명서입니다').first()).toBeVisible();
  await shot(wallet, '11-wallet-revoked');
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 미충족').first()).toBeVisible();
  await expect(verifier.getByText('REVOKED').first()).toBeVisible();
  await shot(verifier, '12-verifier-result-revoked');

  // ── ⑤ 공격 시연 4종 ───────────────────────────────────────────────────────
  await verifier.goto(`${VERIFIER_APP}/attack`);
  for (const [label, code] of [['재사용 제출', 'NONCE_REUSED'], ['만료된 요청', 'NONCE_EXPIRED'], ['위조된 증명서', 'VC_SIG_INVALID'], ['타인 증명서 도용', 'HOLDER_MISMATCH']] as const) {
    await verifier.getByRole('button', { name: label }).click();
    await expect(verifier.getByText(code).first()).toBeVisible();
  }
  await shot(verifier, '13-verifier-attacks');

  // ── ⑦ (선택) 발급기관 정지 후 검증: E2E_ISSUER_DOWN_CMD 가 주어진 경우에만 ──
  if (process.env.E2E_ISSUER_DOWN_CMD) {
    const { execSync } = await import('node:child_process');
    execSync(process.env.E2E_ISSUER_DOWN_CMD, { stdio: 'inherit' });
    await expect
      .poll(async () => { try { const r = await fetch(`${ISSUER_WELFARE}/health`); return r.ok; } catch { return false; } }, { timeout: 30_000 })
      .toBe(false);
    const code5 = await createVerifierRequest(verifier, '햇살론뱅크 대상 확인');
    await presentWithCode(wallet, code5);
    await wallet.getByRole('button', { name: '동의하고 제출' }).click();
    await expect(wallet.getByText('자격 충족').first()).toBeVisible();
    await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
    await expect(verifier.getByText('자격 충족').first()).toBeVisible();
    await shot(verifier, '16-verifier-issuer-down');
  }


  // ── 이력: 원장 대조 ✓ ───────────────────────────────────────────────────
  await wallet.goto(`${WALLET}/history`);
  await expect(wallet.getByText('원장 대조 ✓').first()).toBeVisible();
  await shot(wallet, '14-wallet-history');
});
