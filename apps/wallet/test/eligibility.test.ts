/** 로컬 사전 판정·규칙 해시·추천 필터·조사 헬퍼. */
import { bundleHash } from '@dbp/rules';
import { loadBundle, loadPolicies, policyIndex } from '@dbp/rules/node';
import { describe, expect, it } from 'vitest';
import {
  buildRuleResults,
  checkBundleHash,
  computeClaims,
  credentialHoldings,
  failingClaimLabels,
  fillWithTemplates,
  filterRecommendations,
  getCitizen,
  josa,
  planByIssuer,
  ruleVars,
  templateRecommendation,
} from '@/lib/eligibility';
import type { Recommendation, StoredCredential } from '@/lib/types';

const bundle = loadBundle();
const policies = loadPolicies();
const index = policyIndex(policies);
const c001 = getCitizen('C-001')!;

describe('로컬 사전 판정 (김복례)', () => {
  const claims = computeClaims(bundle, c001);
  const plans = planByIssuer(bundle, claims);

  it('발급기관 순서는 대구광역시 → iM뱅크', () => {
    expect(plans.map((p) => p.name)).toEqual(['대구광역시', 'iM뱅크']);
  });

  it('대구광역시: 거주·50% 이하·65세 이상·1인 가구 발급 가능, 32% 이하는 발급 불가', () => {
    const daegu = plans[0]!;
    const issuable = daegu.issuable.map((d) => d.claim);
    expect(issuable).toEqual(expect.arrayContaining(['daeguResident', 'incomeBelow50Median', 'ageOver65', 'singlePersonHousehold', 'incomeBelow48Median']));
    expect(daegu.denied.map((d) => d.claim)).toEqual(expect.arrayContaining(['incomeBelow32Median', 'hasStudentChild', 'isBenefitRecipient']));
    expect(daegu.denied.find((d) => d.claim === 'incomeBelow32Median')?.label).toBe('기준 중위소득 32% 이하 여부');
  });

  it('iM뱅크: 신용 하위 20%·연소득 3,500만 원 이하 발급 가능', () => {
    expect(plans[1]!.issuable.map((d) => d.claim).sort()).toEqual(['annualIncomeUnder35M', 'creditBottom20']);
    expect(plans[1]!.denied).toEqual([]);
  });

  it('판정 결과에는 불리언만 있다', () => {
    for (const v of Object.values(claims)) expect(typeof v).toBe('boolean');
  });
});

describe('규칙 해시 대조', () => {
  it('발급기관이 알린 해시와 같으면 ok', () => {
    const declared = bundleHash(bundle);
    expect(checkBundleHash(bundle, declared).ok).toBe(true);
    expect(checkBundleHash(bundle, declared.toUpperCase()).ok).toBe(true);
  });
  it('다르거나 없으면 ok=false', () => {
    expect(checkBundleHash(bundle, '0x' + '00'.repeat(32)).ok).toBe(false);
    expect(checkBundleHash(bundle, null).ok).toBe(false);
    // 번들이 한 글자라도 바뀌면 해시가 달라진다
    const tampered = structuredClone(bundle);
    tampered.tables.medianIncomeByHouseholdSize['1'] = (tampered.tables.medianIncomeByHouseholdSize['1'] ?? 0) + 1;
    expect(checkBundleHash(tampered, bundleHash(bundle)).ok).toBe(false);
  });
});

describe('ruleResults / matchedClaims', () => {
  const claims = computeClaims(bundle, c001);
  it('규칙 변수 수집', () => {
    expect(ruleVars(bundle.policies.rules['micro-livelihood-loan']!)).toEqual(['annualIncomeUnder35M', 'creditBottom20', 'isBenefitRecipient', 'incomeBelow50Median']);
    expect(ruleVars({ var: 'x' })).toEqual(['x']);
    expect(ruleVars(true)).toEqual([]);
  });
  it('matchedClaims 는 규칙이 참조한 claim 중 참인 것', () => {
    const r = Object.fromEntries(buildRuleResults(bundle, claims).map((x) => [x.policyId, x]));
    expect(r['basic-pension']?.matchedClaims).toEqual(['ageOver65', 'incomeBelowBasicPensionLine']);
    expect(r['energy-voucher']?.eligible).toBe(false);
    expect(r['energy-voucher']?.matchedClaims).toEqual(['ageOver65']);
  });
  it('부적격 사유 라벨', () => {
    expect(failingClaimLabels(bundle, index['nbl-livelihood'], 'nbl-livelihood', claims)).toEqual(['기준 중위소득 32% 이하 여부']);
    expect(failingClaimLabels(bundle, index['nbl-education'], 'nbl-education', claims)).toEqual(['초·중·고 학생 자녀 유무']);
  });
});

describe('추천 필터 (근거 없으면 비노출)', () => {
  const claims = computeClaims(bundle, c001);
  const eligible = new Set(buildRuleResults(bundle, claims).filter((r) => r.eligible).map((r) => r.policyId));
  const good: Recommendation = { policyId: 'nbl-housing', headline: 'h', explanation: 'e', citations: ['nbl-housing-c1'], nextSteps: 'n', source: 'llm' };

  it('적격이 아닌 정책·없는 조항·없는 정책은 버린다', () => {
    const recs: Recommendation[] = [
      good,
      { ...good, policyId: 'nbl-livelihood', citations: ['nbl-livelihood-c1'] }, // 부적격
      { ...good, policyId: 'near-poor', citations: ['near-poor-c99'] }, // 없는 조항
      { ...good, policyId: 'ghost-policy', citations: ['x'] }, // 없는 정책
      { ...good, policyId: 'basic-pension', citations: [] }, // 인용 없음
      good, // 중복
    ];
    expect(filterRecommendations(recs, index, eligible).map((r) => r.policyId)).toEqual(['nbl-housing']);
  });

  it('3개 미만이면 적격 정책을 템플릿으로 채운다 (복지 → 금융 → 교통)', () => {
    const filled = fillWithTemplates([good], index, eligible);
    expect(filled).toHaveLength(3);
    expect(filled[0]?.policyId).toBe('nbl-housing');
    expect(filled.slice(1).every((r) => r.source === 'template' && eligible.has(r.policyId))).toBe(true);
    const t = templateRecommendation(index['near-poor']!);
    expect(t.citations).toEqual(['near-poor-c1']);
    expect(t.explanation).toContain('규칙 엔진');
  });
});

describe('증명서 보유 표시', () => {
  const claims = computeClaims(bundle, c001);
  const creds: StoredCredential[] = [
    { jti: '1', claim: 'incomeBelow50Median', label: '', value: true, vcJwt: 'a', issuerDid: 'did:dbp:daegu', issuerName: '대구광역시', statusListIndex: 0, validUntil: '', issuedAt: '' },
  ];
  it('expected=false 항목은 참 증명서가 없고 로컬 판정이 거짓이면 충족', () => {
    const h = credentialHoldings(index['near-poor']!, creds, claims, bundle);
    expect(h.map((x) => [x.claim, x.held])).toEqual([
      ['incomeBelow50Median', true],
      ['isBenefitRecipient', true],
    ]);
    expect(h[1]?.note).toBeDefined();
  });
  it('증명서가 없으면 미보유', () => {
    const h = credentialHoldings(index['basic-pension']!, creds, claims, bundle);
    expect(h.every((x) => !x.held)).toBe(true);
  });
});

describe('조사', () => {
  it('받침에 따라 이/가', () => {
    expect(josa('iM뱅크 칠성동지점', '이/가')).toBe('iM뱅크 칠성동지점이');
    expect(josa('대구 북구 행정복지센터', '이/가')).toBe('대구 북구 행정복지센터가');
    expect(josa('ABC', '이/가')).toBe('ABC이');
  });
});
