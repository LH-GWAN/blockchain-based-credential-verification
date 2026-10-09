/**
 * tests/test_loan_income_rules.py 의 미러 — 서민금융 연소득 기준 경계값 (2026.2 번들).
 *  - 햇살론 일반보증 (2026.1.2 근로자햇살론·햇살론뱅크 통합): 연소득 3,500만 원 이하, 또는 신용평점 하위 20% + 4,500만 원 이하
 *  - 새희망홀씨Ⅱ (은행권): 연소득 4,000만 원 이하, 또는 신용평점 하위 20% + 5,000만 원 이하
 * 기준은 모두 '이하'이므로 기준액은 참, 1원 초과는 거짓이어야 한다.
 */
import { describe, expect, it } from 'vitest';
import { evaluateClaims, evaluatePolicies, loadBundle, repoRoot, type ClaimMap } from '../src/node.js';

const BUNDLE = loadBundle(repoRoot());
const AS_OF = '2026-09-14';
const INCOME_CLAIMS = ['annualIncomeUnder35M', 'annualIncomeUnder40M', 'annualIncomeUnder45M', 'annualIncomeUnder50M'];

/** 은행이 아는 두 값(신용 등급·연소득)만으로 claim 을 만든다. */
function bankClaims(tier: string, income: number): ClaimMap {
  return evaluateClaims(BUNDLE, { creditScoreTier: tier, annualIncomeKRW: income }, AS_OF, ['creditBottom20', ...INCOME_CLAIMS]);
}

function loans(tier: string, income: number): { sunshine: boolean; newHope: boolean } {
  const claims: ClaimMap = Object.fromEntries(Object.keys(BUNDLE.claims.rules).map((k) => [k, false]));
  Object.assign(claims, bankClaims(tier, income));
  const pol = evaluatePolicies(BUNDLE, claims);
  return { sunshine: pol['sunshine-loan-general']!, newHope: pol['new-hope-loan']! };
}

describe('loan income thresholds (2026.2)', () => {
  it.each([
    ['annualIncomeUnder35M', 35_000_000],
    ['annualIncomeUnder40M', 40_000_000],
    ['annualIncomeUnder45M', 45_000_000],
    ['annualIncomeUnder50M', 50_000_000],
  ] as const)('%s boundary: %i is true, +1 is false', (claim, limit) => {
    expect(bankClaims('other', limit)[claim]).toBe(true);
    expect(bankClaims('other', limit + 1)[claim]).toBe(false);
  });

  it('new income claims are welfare-issued and labeled', () => {
    expect(BUNDLE.claims.issuerOf['annualIncomeUnder40M']).toBe('did:dbp:welfare');
    expect(BUNDLE.claims.issuerOf['annualIncomeUnder50M']).toBe('did:dbp:welfare');
    expect(BUNDLE.claims.labels['annualIncomeUnder40M']).toBe('연소득 4,000만 원 이하 여부');
    expect(BUNDLE.claims.labels['annualIncomeUnder50M']).toBe('연소득 5,000만 원 이하 여부');
  });

  it('new-hope-loan branches', () => {
    // 연소득 4,000만 원 이하면 신용평점과 무관하게 대상
    expect(loans('other', 40_000_000).newHope).toBe(true);
    expect(loans('other', 40_000_001).newHope).toBe(false);
    // 하위 20% 는 5,000만 원 이하까지
    expect(loans('bottom20', 50_000_000).newHope).toBe(true);
    expect(loans('bottom20', 50_000_001).newHope).toBe(false);
    // 하위 20% 가 아니면 4,500만 원이어도 대상 아님 (옛 3,500만/4,500만 기준과 다름)
    expect(loans('other', 45_000_000).newHope).toBe(false);
  });

  it('sunshine-loan-general keeps 35M and bottom20 + 45M', () => {
    expect(BUNDLE.policies.rules).not.toHaveProperty('sunshine-loan-bank');
    expect(loans('other', 35_000_000).sunshine).toBe(true);
    expect(loans('other', 35_000_001).sunshine).toBe(false);
    expect(loans('bottom20', 45_000_000).sunshine).toBe(true);
    expect(loans('bottom20', 45_000_001).sunshine).toBe(false);
  });

  it('income band between products: 35M < income <= 40M (credit other) is new-hope only', () => {
    expect(loans('other', 38_000_000)).toEqual({ sunshine: false, newHope: true });
  });
});
