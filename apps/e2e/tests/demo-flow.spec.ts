/**
 * 시연 ①~⑦ 자동 재현 (docs/DEMO.md). 스크린샷은 docs/screenshots/ 에 저장한다.
 *  ① 지갑 생성·증명서 발급  ② 창구 혜택 안내  ③ QR(코드) 제출  ③′ 햇살론 일반보증 1항목(iM뱅크)·같은 증명서로 iM저축은행 재사용  ④ 기관 검증 PASS  ⑥ 조회형 대비 비교 패널
 *  ⑤ 폐기 후 차단 + 공격 시연 4종  ⑦ (선택) 발급기관 정지 후 검증 PASS — 별도 test, E2E_ISSUER_DOWN_CMD 가 없으면 skipped 로 표시된다
 * 두 test 는 같은 지갑·검증기관 페이지를 이어 쓴다(serial). ⑦은 ①에서 받은 증명서로 제출한다.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 주소 우선순위: 환경변수 → make demo 가 남긴 .demo/*.url → 기본값
function urlFrom(envName: string, file: string, fallback: string): string {
  if (process.env[envName]) return process.env[envName]!;
  const p = join(process.cwd(), '..', '..', '.demo', file);
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : fallback;
}
const WALLET = urlFrom('WALLET_URL', 'wallet.url', 'http://localhost:3000');
const VERIFIER_APP = urlFrom('VERIFIER_APP_URL', 'verifier-app.url', 'http://localhost:3001');
// Node fetch 는 서비스가 기본으로 묶이는 127.0.0.1 로 직접 접속한다 (브라우저 쪽 주소는 앱 설정을 따른다).
const ISSUER_WELFARE = process.env.ISSUER_WELFARE_URL ?? 'http://127.0.0.1:8003';
// 발급기관 /admin/* : ADMIN_TOKEN 을 설정한 스택이면 헤더로 보내고, 아니면 로컬 접속으로 허용된다.
const ADMIN_HEADERS: Record<string, string> = process.env.ADMIN_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_TOKEN } : {};
const SHOTS = join(process.cwd(), '..', '..', 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** 복지기관 관리 API 호출. 200 이 아니면 응답 본문을 보여 주고 실패한다 (예: 503 LEDGER_PUBLISH_FAILED). */
async function welfareAdmin(path: string, method: 'GET' | 'POST' = 'GET') {
  const r = await fetch(`${ISSUER_WELFARE}${path}`, { method, headers: ADMIN_HEADERS });
  const body = await r.json().catch(() => null);
  expect(r.status, `${method} ${path} → ${JSON.stringify(body)}`).toBe(200);
  return body;
}

async function newContexts(browser: Browser) {
  const wallet = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ko-KR' })).newPage();
  const verifier = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ko-KR' })).newPage();
  return { wallet, verifier };
}

/**
 * 검증기관 → 프리셋 순서로 고른다. 검증기관 앱은 고른 창구 종류(verifierKinds)가 취급하지 않는 프리셋을 숨기고,
 * 창구를 바꾸면 취급하지 않는 프리셋 선택을 지우므로 창구를 먼저 골라야 한다.
 * hiddenPresets: 이 창구에서 보이지 않아야 하는 프리셋 이름 (예: 저축은행의 새희망홀씨).
 * 프리셋 칩은 이름 전체가 같은 것만 고른다 — getByRole 의 name 은 기본이 부분 일치라
 * '햇살론 일반보증 · 신용 하위 20% 고객' 같은 비슷한 칩이 늘어도 엉뚱한 칩을 누르지 않게.
 * 숨김 확인은 반대로 부분 일치로 둔다 (이름이 조금 바뀌어도 칩이 남아 있으면 잡히게).
 */
async function createVerifierRequest(verifier: Page, preset?: string, verifierName?: string, hiddenPresets: readonly string[] = []): Promise<string> {
  await verifier.goto(`${VERIFIER_APP}/`);
  if (verifierName) await verifier.getByRole('radio', { name: new RegExp(verifierName) }).check();
  if (preset) {
    const chip = verifier.getByRole('button', { name: preset, exact: true }).first();
    await expect(chip).toBeVisible(); // 프리셋 목록이 그려진 뒤에 숨김 여부를 본다
    for (const hidden of hiddenPresets) await expect(verifier.getByRole('button', { name: hidden })).toHaveCount(0);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  }
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

test.describe.configure({ mode: 'serial' });
let wallet: Page;
let verifier: Page;
test.beforeAll(async ({ browser }) => {
  ({ wallet, verifier } = await newContexts(browser));
});
test.afterAll(async () => {
  await wallet?.context().close();
  await verifier?.context().close();
});

test('①~⑥ 시연 흐름 + ⑤ 폐기·공격 4종', async () => {

  // ── ① 지갑 생성 → 사전 판정 → 동의 → 발급 ───────────────────────────────
  await wallet.goto(`${WALLET}/`);
  await expect(wallet.getByRole('button', { name: '내 지갑 만들기' })).toBeVisible();
  await expect(wallet.locator('select')).toHaveValue('C-001');
  await shot(wallet, '01-wallet-home');
  await wallet.getByRole('button', { name: '내 지갑 만들기' }).click();

  await wallet.waitForURL(/\/credentials/);
  await expect(wallet.getByText('해시 일치 ✓')).toBeVisible();
  await expect(wallet.getByText('이 판정은 내 휴대폰 안에서만 계산되었습니다 (개인정보 전송 없음)')).toBeVisible();
  await expect(wallet.getByText('발급 가능').first()).toBeVisible();
  // 사전 판정 표: 조건에 맞지 않는 항목은 "해당하지 않음" (추가 서류 없음)
  await expect(wallet.getByRole('row', { name: /기준 중위소득 32% 이하 여부.*해당하지 않음/ }).first()).toBeVisible();
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
  // "자세히"는 표로 — 발급기관·증명 내용·발급일·유효기간·증명서 번호
  await wallet.getByRole('button', { name: '자세히' }).first().click();
  await expect(wallet.getByRole('row', { name: /증명 내용.*: 참/ }).first()).toBeVisible();
  await expect(wallet.getByRole('row', { name: /증명서 번호/ }).first()).toBeVisible();
  await shot(wallet, '04-wallet-credentials');

  // ── ② 창구 혜택 안내 (은행·민간 먼저, 공공 복지는 복지멤버십 안내 대상으로 짧게) ──
  await wallet.goto(`${WALLET}/benefits`);
  await expect(wallet.getByText(/은행·민간 창구 혜택/).first()).toBeVisible();
  await expect(wallet.getByText(/공공 복지/).first()).toBeVisible();
  await expect(wallet.getByText('지금은 해당되지 않는 혜택').first()).toBeVisible();
  await expect(wallet.getByText('햇살론 일반보증').first()).toBeVisible({ timeout: 60_000 });
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
  // 영수증 txHash: 영수증 해시·vpHash 도 같은 0x… 64자리라 화면 전체가 아니라 tx 요소만 본다 (앵커 실패를 놓치지 않게)
  await expect(verifier.getByTestId('receipt-tx')).toContainText(/0x[0-9a-f]{64}/, { timeout: 40_000 });
  // 창구 화면의 확인 숫자 4자리 = 지갑이 제출한 VP 로 직접 계산한 숫자 (원격 대리 제출 확인)
  const confirm = (await verifier.getByTestId('confirm-code').first().innerText()).replace(/\D/g, '');
  expect(confirm).toMatch(/^\d{4}$/);
  await expect(wallet.locator('main')).toContainText(new RegExp(`확인 숫자\\s*${confirm}`));
  await shot(verifier, '10-verifier-result-pass');
  const verifierText = await verifier.locator('main').innerText();
  expect(verifierText).not.toContain('김복례');
  expect(verifierText).not.toContain('1000000');

  // ── ③' 햇살론 일반보증 용도 (iM뱅크): 소득금액증명 원본 대신 '연소득 3,500만 원 이하 = 참' 1개 항목만 ──
  const code3 = await createVerifierRequest(verifier, '햇살론 일반보증 대상 확인');
  await presentWithCode(wallet, code3);
  await expect(wallet.getByText('연소득 3,500만 원 이하 여부', { exact: false }).first()).toBeVisible();
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('자격 충족').first()).toBeVisible();
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 충족').first()).toBeVisible();
  await expect(verifier.getByText(/정책 판정 재현/).first()).toBeVisible();
  await shot(verifier, '10b-verifier-result-sunshine-bank'); // 파일명은 docs 참조 유지를 위해 그대로 둔다

  // ── ⑥ 조회형 대비 비교 패널 (§12.5): 숫자는 서비스(data/comparison.json)에서 온다 ──
  const panel = verifier.getByTestId('comparison-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('같은 자격 확인, 두 경로 비교')).toBeVisible();
  await expect(panel.getByText('서류 제출 방식 (원문)')).toBeVisible();
  await expect(panel.getByText('대구 혜택패스 (보유형)')).toBeVisible();
  await expect(panel.getByText('소득금액증명', { exact: false }).first()).toBeVisible();
  await expect(verifier.getByTestId('comparison-summary')).toHaveText(/이번 검증에서 줄어든 항목: 10 → 1 \(90%\)/);
  await expect(panel.getByText(/3년 보관/)).toBeVisible();
  await expect(panel.getByText(/공식 서식에 기재된 항목/)).toBeVisible();
  // 보유형 쪽 '남는 기록'은 원장의 제출 영수증 솔트 해시 1건 (F13) — '없음'이라고 쓰지 않는다
  const hold = verifier.getByTestId('comparison-hold');
  await expect(hold).toContainText('원장에 제출 영수증의 솔트 해시 1건');
  await expect(hold).not.toContainText(/남는 기록: ?없음/);
  const panelText = await panel.innerText();
  expect(panelText).not.toMatch(/유출(이)? ?불가|개인정보가 사라|종이(를| ?증명서를) ?없|행정기관 사이에서만/); // D-18 금지 문구
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(SHOTS, '15-verifier-comparison.png') });
  // 모바일 폭에서 세로 스택(조회형이 먼저). 결과 조회에는 이 탭의 창구 토큰(sessionStorage)이 필요하므로 새 컨텍스트 대신 폭만 줄인다.
  await verifier.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const pullBox = await verifier.getByTestId('comparison-pull').boundingBox();
      const holdBox = await verifier.getByTestId('comparison-hold').boundingBox();
      return !!(pullBox && holdBox && pullBox.y < holdBox.y && Math.abs(pullBox.x - holdBox.x) < 4);
    })
    .toBe(true);
  await verifier.getByTestId('comparison-panel').screenshot({ path: join(SHOTS, '15b-verifier-comparison-mobile.png') });
  await verifier.setViewportSize({ width: 1280, height: 860 });

  // ── ③' 재사용: 같은 카드, 다른 창구 (iM저축은행 + 햇살론 일반보증) — 재발급 없이 통과 (§2-8) ──
  // 2026.1.2 개편으로 햇살론 일반보증은 저축은행도 취급한다. 새희망홀씨는 은행권 상품이라 저축은행 창구에는 보이지 않는다.
  // 스택을 오래 켜 두면 이전 실행의 발급분이 발급기관 DB 에 누적되므로, 절대 건수 대신 ③' 전후 건수를 비교한다.
  const countIssued = async (claim: string) =>
    ((await welfareAdmin('/admin/credentials')).credentials as { claim: string }[]).filter((c) => c.claim === claim).length;
  const issuedBefore = await countIssued('annualIncomeUnder35M');
  const code4 = await createVerifierRequest(verifier, '햇살론 일반보증 대상 확인', 'iM저축은행', ['새희망홀씨 대상 확인', '새희망홀씨 · 신용 하위 20% 고객']);
  await presentWithCode(wallet, code4);
  await expect(wallet.getByText('iM저축은행', { exact: false }).first()).toBeVisible();
  await expect(wallet.getByText('연소득 3,500만 원 이하 여부', { exact: false }).first()).toBeVisible();
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('자격 충족').first()).toBeVisible();
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 충족').first()).toBeVisible();
  await expect(verifier.getByText('iM저축은행', { exact: false }).first()).toBeVisible();
  await shot(verifier, '10c-verifier-result-reuse-savings');
  // 발급기관에 새 발급이 없었음을 확인 (재발급 없이 재사용)
  expect(await countIssued('annualIncomeUnder35M')).toBe(issuedBefore);

  // ── ⑤ 폐기 → 재제출 차단 ──────────────────────────────────────────────────
  const admin = await welfareAdmin('/admin/credentials');
  // 이전 실행분이 남아 있을 수 있으므로 이번 실행에서 발급된(가장 최근) 증명서를 폐기 대상으로 고른다.
  const target = (admin.credentials as { claim: string; issued_at: number; jti: string }[])
    .filter((c) => c.claim === 'incomeBelow50Median')
    .sort((a, b) => b.issued_at - a.issued_at)[0];
  expect(target).toBeTruthy();
  // 원장 게시에 실패하면 503 LEDGER_PUBLISH_FAILED 로 실패한다 — 200 이면 상태목록 게시 tx 가 있어야 한다
  const rv = await welfareAdmin(`/admin/credentials/${target.jti}/revoke`, 'POST');
  expect(rv.revoked).toBe(true);
  expect(rv.txHash).toMatch(/^0x[0-9a-f]{64}$/);

  const code2 = await createVerifierRequest(verifier);
  await presentWithCode(wallet, code2);
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('제출 거부됨').first()).toBeVisible();
  await expect(wallet.getByText('폐기된 증명서입니다').first()).toBeVisible();
  await shot(wallet, '11-wallet-revoked');
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 미충족').first()).toBeVisible();
  await expect(verifier.getByText('REVOKED').first()).toBeVisible();
  await expect(verifier.getByText(/정책 판정 재현/)).toHaveCount(0); // FAIL 결과에는 정책 판정(적격) 카드가 없다
  await shot(verifier, '12-verifier-result-revoked');

  // ── ⑤ 공격 시연 4종 ───────────────────────────────────────────────────────
  // 카드 설명에 예상 코드가 항상 적혀 있으므로, 단언은 그 카드의 결과 블록(클릭 후에만 생긴다)과 실제 API 응답으로 한다.
  await verifier.goto(`${VERIFIER_APP}/attack`);
  const attacks = [
    ['replay', '재사용 제출', 'NONCE_REUSED'],
    ['expired', '만료된 요청', 'NONCE_EXPIRED'],
    ['forged', '위조된 증명서', 'VC_SIG_INVALID'],
    ['wrong-holder', '타인 증명서 도용', 'HOLDER_MISMATCH'],
  ] as const;
  const runAttack = async (kind: string, label: string, code: string) => {
    const card = verifier.getByTestId(`attack-card-${kind}`);
    const [resp] = await Promise.all([
      verifier.waitForResponse((r) => r.url().endsWith('/demo/attack') && r.request().method() === 'POST'),
      card.getByRole('button', { name: label }).click(),
    ]);
    const body = await resp.json();
    expect(body.verdict, `${kind}: ${JSON.stringify(body.reasonCodes)}`).toBe('FAIL');
    expect(body.reasonCodes).toContain(code);
    const result = verifier.getByTestId(`attack-result-${kind}`);
    await expect(result).toContainText('차단됨');
    await expect(result).toContainText(`${code} 확인`);
  };
  for (const [kind, label, code] of attacks) {
    await expect(verifier.getByTestId(`attack-result-${kind}`)).toHaveCount(0); // 클릭 전에는 결과가 없다
    await runAttack(kind, label, code);
  }
  // 만료 공격 뒤에 재사용을 다시 눌러도 NONCE_REUSED 로 남는다 (만료 공격이 원래 요청 상태를 바꾸지 않음)
  await runAttack(...attacks[0]);
  await shot(verifier, '13-verifier-attacks');

  // ── 이력: 영수증 원문·원장 기록 (⑦에서 발급기관을 끄기 전에 확인한다) ─────────────
  await wallet.goto(`${WALLET}/history`);
  // 로컬 대조(원문 → 해시)와 원장 기록 확인은 따로다 (F25): 원장 조회는 영수증마다 '원장에서 확인' 을 눌러야 한다 (F40)
  await expect(wallet.getByText('영수증 원문·해시 일치 ✓').first()).toBeVisible();
  // 앵커 tx 가 아직 블록에 없으면 '확인하지 못했습니다' 와 함께 버튼이 다시 나오므로, 기록될 때까지 다시 누른다
  await expect(async () => {
    const check = wallet.getByRole('button', { name: '원장에서 확인' }).first();
    if (await check.isVisible()) await check.click();
    await expect(wallet.getByText(/원장에 기록됨/).first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 40_000 });
  // 영수증 내용은 표로 — 종류·검증기관·1회용 확인번호·시각
  await wallet.getByRole('button', { name: /영수증 내용/ }).first().click();
  await expect(wallet.getByRole('row', { name: /종류.*제출 영수증/ }).first()).toBeVisible();
  await expect(wallet.getByRole('row', { name: /1회용 확인번호/ }).first()).toBeVisible();
  await shot(wallet, '14-wallet-history');
});

test('⑦ 발급기관 정지 후 검증 PASS', async () => {
  test.skip(!process.env.E2E_ISSUER_DOWN_CMD, 'E2E_ISSUER_DOWN_CMD 가 없어 ⑦을 실행하지 않음 (예: E2E_ISSUER_DOWN_CMD="pkill -f dbp_issuer")');
  const { execSync } = await import('node:child_process');
  execSync(process.env.E2E_ISSUER_DOWN_CMD!, { stdio: 'inherit' });
  await expect
    .poll(async () => { try { const r = await fetch(`${ISSUER_WELFARE}/health`); return r.ok; } catch { return false; } }, { timeout: 30_000 })
    .toBe(false);
  const code5 = await createVerifierRequest(verifier, '햇살론 일반보증 대상 확인');
  await presentWithCode(wallet, code5);
  await wallet.getByRole('button', { name: '동의하고 제출' }).click();
  await expect(wallet.getByText('자격 충족').first()).toBeVisible();
  await verifier.waitForURL(/\/result\//, { timeout: 30_000 });
  await expect(verifier.getByText('자격 충족').first()).toBeVisible();
  await shot(verifier, '16-verifier-issuer-down');
});
