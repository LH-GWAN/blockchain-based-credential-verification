/**
 * tests/test_median_income_2026.py (F04) · test_discount_rules.py (F05) 의 미러.
 *  - 기준 중위소득: 보건복지부 고시 제2025-135호 (월, 원). 2026.2 이전 데이터는 5인·6인 값이 틀렸다.
 *    7인 이상 가구는 MVP 에서 6인 기준을 그대로 쓴다 (전처리 clampInt max=6).
 *  - 전기요금 복지할인: 수급자 OR 중위소득 50% 이하 (한전 복지할인 대상에 기초연금 수급자는 없다).
 *  - 이동통신 요금감면: 수급자 OR 50% 이하 OR (65세 이상 AND 기초연금 선정기준액 이하).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateClaims, evaluatePolicies, loadBundle, repoRoot, type ClaimMap } from '../src/node.js';

const ROOT = repoRoot();
const BUNDLE = loadBundle(ROOT);
const AS_OF = '2026-09-14';
const MEDIAN = JSON.parse(readFileSync(join(ROOT, 'data/median-income-2026.json'), 'utf-8')) as {
  year: number;
  source: string;
  verified: boolean;
  verifiedOn: string;
  byHouseholdSize: Record<string, number>;
};
const EXPECTED = Object.fromEntries(
  (JSON.parse(readFileSync(join(ROOT, 'data/expected.json'), 'utf-8')) as { rows: Array<{ citizenId: string; claims: ClaimMap; policies: ClaimMap }> }).rows.map(
    (r) => [r.citizenId, r],
  ),
);

const GOSI_2025_135 = { '1': 2_564_238, '2': 4_199_292, '3': 5_359_036, '4': 6_494_738, '5': 7_556_719, '6': 8_555_952 };

function profile(size: number, monthly: number) {
  return {
    birthDate: '1980-01-15',
    residence: { sido: '대구광역시', sigungu: '중구' },
    householdSize: size,
    monthlyIncomeKRW: monthly,
    isBasicLivelihoodRecipient: false,
    hasStudentChild: false,
    creditScoreTier: 'other',
    annualIncomeKRW: monthly * 12,
  };
}

describe('기준 중위소득 2026 (F04)', () => {
  it('data 파일은 고시 제2025-135호 값이다', () => {
    expect(MEDIAN.year).toBe(2026);
    expect(MEDIAN.source).toContain('제2025-135호');
    expect(MEDIAN.verified).toBe(true);
    expect(MEDIAN.verifiedOn).toBe('2026-10-09');
    expect(MEDIAN.byHouseholdSize).toEqual(GOSI_2025_135);
  });

  it('조립된 번들 표(medianIncomeByHouseholdSize)도 같은 6개 값이다', () => {
    expect(BUNDLE.tables.medianIncomeByHouseholdSize).toEqual(GOSI_2025_135);
    expect(BUNDLE.tables.medianIncomeYear).toBe(2026);
  });

  it.each([1, 2, 3, 4, 5, 6])("%i인 가구: 32·48·50% 선은 '이하' (내림 금액은 참, 1원 많으면 거짓)", (size) => {
    const median = GOSI_2025_135[String(size) as keyof typeof GOSI_2025_135];
    for (const [claim, pct] of [['incomeBelow32Median', 32], ['incomeBelow48Median', 48], ['incomeBelow50Median', 50]] as const) {
      const line = Math.floor((median * pct) / 100);
      expect(evaluateClaims(BUNDLE, profile(size, line), AS_OF, [claim])[claim], `${size}인 ${claim} ${line}`).toBe(true);
      expect(evaluateClaims(BUNDLE, profile(size, line + 1), AS_OF, [claim])[claim], `${size}인 ${claim} ${line + 1}`).toBe(false);
    }
  });

  it.each([7, 8, 10])('%i인 가구는 6인 기준 중위소득으로 판정한다 (MVP 단순화)', (size) => {
    const line50 = Math.floor(GOSI_2025_135['6'] / 2);
    for (const monthly of [line50, line50 + 1, Math.floor((GOSI_2025_135['6'] * 32) / 100)]) {
      expect(evaluateClaims(BUNDLE, profile(size, monthly), AS_OF), `${size}인 ${monthly}`).toEqual(evaluateClaims(BUNDLE, profile(6, monthly), AS_OF));
    }
  });
});

describe('공공요금 감면 규칙 (F05)', () => {
  const ALL_FALSE: ClaimMap = Object.fromEntries(Object.keys(BUNDLE.claims.rules).map((k) => [k, false]));
  const PENSION_ONLY: ClaimMap = { ...ALL_FALSE, ageOver65: true, incomeBelowBasicPensionLine: true };

  it('규칙 원문', () => {
    const half = { var: 'incomeBelow50Median' };
    const recipient = { var: 'isBenefitRecipient' };
    expect(BUNDLE.policies.rules['electricity-welfare-discount']).toEqual({ or: [recipient, half] });
    expect(BUNDLE.policies.rules['city-gas-discount']).toEqual({ or: [recipient, half] });
    expect(BUNDLE.policies.rules['telecom-discount']).toEqual({
      or: [recipient, half, { and: [{ var: 'ageOver65' }, { var: 'incomeBelowBasicPensionLine' }] }],
    });
  });

  it('기초연금 선만 충족: 통신요금은 대상, 전기·가스는 아니다', () => {
    const pol = evaluatePolicies(BUNDLE, PENSION_ONLY);
    expect(pol['basic-pension']).toBe(true);
    expect(pol['telecom-discount']).toBe(true);
    expect(pol['electricity-welfare-discount']).toBe(false);
    expect(pol['city-gas-discount']).toBe(false);
  });

  it('통신요금의 기초연금 경로는 65세 이상과 선정기준액 이하가 모두 필요', () => {
    expect(evaluatePolicies(BUNDLE, { ...PENSION_ONLY, ageOver65: false })['telecom-discount']).toBe(false);
    expect(evaluatePolicies(BUNDLE, { ...PENSION_ONLY, incomeBelowBasicPensionLine: false })['telecom-discount']).toBe(false);
  });

  it('수급자 또는 중위소득 50% 이하는 세 감면 모두 대상', () => {
    for (const k of ['isBenefitRecipient', 'incomeBelow50Median']) {
      const pol = evaluatePolicies(BUNDLE, { ...ALL_FALSE, [k]: true });
      expect([pol['telecom-discount'], pol['electricity-welfare-discount'], pol['city-gas-discount']], k).toEqual([true, true, true]);
    }
  });

  it('C-013·C-015·C-017 (기초연금 선만 충족): 통신요금 참, 전기·가스 거짓', () => {
    for (const cid of ['C-013', 'C-015', 'C-017']) {
      const p = EXPECTED[cid]!.policies;
      expect([p['basic-pension'], p['telecom-discount'], p['electricity-welfare-discount'], p['city-gas-discount']], cid).toEqual([true, true, false, false]);
    }
    const c = EXPECTED['C-013']!.claims;
    expect([c['ageOver65'], c['incomeBelowBasicPensionLine'], c['incomeBelow50Median'], c['isBenefitRecipient']]).toEqual([true, true, false, false]);
  });
});
