/** tests/test_housing_claims.py 의 미러 — 세대주·혼인·재직·연소득 6,000만 원 (2026.2 번들). */
import { describe, expect, it } from 'vitest';
import { evaluateClaims, loadBundle, repoRoot } from '../src/node.js';

const BUNDLE = loadBundle(repoRoot());
const AS_OF = '2026-09-14';

describe('housing loan claims (2026.2)', () => {
  it('issuers and labels', () => {
    expect(BUNDLE.claims.issuerOf['householdHead']).toBe('did:dbp:daegu');
    expect(BUNDLE.claims.issuerOf['married']).toBe('did:dbp:daegu');
    expect(BUNDLE.claims.issuerOf['employed']).toBe('did:dbp:welfare');
    expect(BUNDLE.claims.issuerOf['annualIncomeUnder60M']).toBe('did:dbp:welfare');
    expect(BUNDLE.claims.labels['annualIncomeUnder60M']).toBe('연소득 6,000만 원 이하 여부');
  });

  it('60M boundary', () => {
    expect(evaluateClaims(BUNDLE, { annualIncomeKRW: 60_000_000 }, AS_OF, ['annualIncomeUnder60M'])).toEqual({ annualIncomeUnder60M: true });
    expect(evaluateClaims(BUNDLE, { annualIncomeKRW: 60_000_001 }, AS_OF, ['annualIncomeUnder60M'])).toEqual({ annualIncomeUnder60M: false });
  });

  it.each([
    ['isHouseholdHead', 'householdHead'],
    ['isMarried', 'married'],
    ['isEmployed', 'employed'],
  ] as const)('%s → %s', (field, claim) => {
    expect(evaluateClaims(BUNDLE, { [field]: true }, AS_OF, [claim])).toEqual({ [claim]: true });
    expect(evaluateClaims(BUNDLE, { [field]: false }, AS_OF, [claim])).toEqual({ [claim]: false });
  });
});
