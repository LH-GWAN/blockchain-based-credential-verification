/** 로컬 사전 판정·규칙 해시·추천 필터·창구 분류·조사 헬퍼. */
import { bundleHash } from '@dbp/rules';
import { loadBundle, loadPolicies, policyIndex } from '@dbp/rules/node';
import { describe, expect, it } from 'vitest';
import {
  buildRuleResults,
  checkBundleHash,
  chooseClaimSet,
  computeClaims,
  counterChecks,
  credentialHoldings,
  failingClaimLabels,
  filterRecommendations,
  getCitizen,
  groupEligibleByChannel,
  isSelfChecked,
  issuerDidsInOrder,
  josa,
  pickRecommendation,
  planByIssuer,
  policyChannel,
  ruleVars,
  selfCheckedClaims,
  submitDocuments,
  templateRecommendation,
} from '@/lib/eligibility';
import { ISSUERS, ISSUER_URL_BY_DID, SELF_ISSUER } from '@/lib/env';
import type { PolicyMeta, Recommendation, RequiredClaim, StoredCredential } from '@/lib/types';

const bundle = loadBundle();
const policies = loadPolicies();
const index = policyIndex(policies);
const c001 = getCitizen('C-001')!;

/** 2026.2 이전 형식의 정책 문서 (requiredClaimSets 없이 requiredClaims 단일 목록) — 지갑 캐시에 남아 있을 수 있다. */
function legacyPolicy(base: PolicyMeta, requiredClaims: RequiredClaim[]): PolicyMeta {
  const { requiredClaimSets: _drop, ...rest } = base;
  return { ...rest, requiredClaims } as unknown as PolicyMeta;
}

/** data/expected.json C-001 (김복례) 의 적격 정책. */
const C001_ELIGIBLE = [
  'nbl-housing',
  'near-poor',
  'basic-pension',
  'telecom-discount',
  'micro-livelihood-loan',
  'daegu-metro-free',
  'sunshine-loan-general',
  'new-hope-loan',
  'electricity-welfare-discount',
  'city-gas-discount',
];

describe('발급기관 지도 (공공기관만)', () => {
  it('발급기관은 대구광역시 → 사회보장정보원(복지기관) 둘뿐이고 은행은 없다', () => {
    expect(ISSUERS.map((i) => [i.did, i.name])).toEqual([
      ['did:dbp:daegu', '대구광역시'],
      ['did:dbp:welfare', '사회보장정보원(복지기관)'],
    ]);
    expect(ISSUER_URL_BY_DID).toEqual({ 'did:dbp:daegu': 'http://localhost:8001', 'did:dbp:welfare': 'http://localhost:8003' });
    expect(JSON.stringify(ISSUERS)).not.toMatch(/bank|뱅크|은행/i);
  });

  it('번들 issuerOf 의 발급기관 순서 (self 제외) 는 지갑 발급기관 순서와 같다', () => {
    expect(issuerDidsInOrder(bundle)).toEqual(ISSUERS.map((i) => i.did));
    expect(bundle.claims.issuerOf['creditBottom20']).toBe(SELF_ISSUER);
    expect(isSelfChecked(bundle, 'creditBottom20')).toBe(true);
    expect(isSelfChecked(bundle, 'annualIncomeUnder35M')).toBe(false);
  });
});

describe('로컬 사전 판정 (김복례)', () => {
  const claims = computeClaims(bundle, c001);
  const plans = planByIssuer(bundle, claims);

  it('발급기관 순서는 대구광역시 → 사회보장정보원(복지기관)', () => {
    expect(plans.map((p) => p.name)).toEqual(['대구광역시', '사회보장정보원(복지기관)']);
    expect(plans.map((p) => p.did)).toEqual(['did:dbp:daegu', 'did:dbp:welfare']);
  });

  it('대구광역시: 거주·65세 이상·무임 연령·1인 가구·세대주 발급 가능, 학생 자녀·기혼은 발급 불가', () => {
    const daegu = plans[0]!;
    expect(daegu.issuable.map((d) => d.claim).sort()).toEqual([
      'ageOver65',
      'daeguMetroFreeAge',
      'daeguResident',
      'householdHead',
      'singlePersonHousehold',
    ]);
    expect(daegu.denied.map((d) => d.claim).sort()).toEqual(['hasStudentChild', 'married']);
  });

  it('사회보장정보원: 소득구간·연소득(3,500·4,000·4,500·5,000·6,000만 원) 발급 가능, 32% 이하·수급 여부·재직은 발급 불가', () => {
    const welfare = plans[1]!;
    expect(welfare.issuable.map((d) => d.claim).sort()).toEqual([
      'annualIncomeUnder35M',
      'annualIncomeUnder40M',
      'annualIncomeUnder45M',
      'annualIncomeUnder50M',
      'annualIncomeUnder60M',
      'incomeBelow48Median',
      'incomeBelow50Median',
      'incomeBelowBasicPensionLine',
    ]);
    expect(welfare.denied.map((d) => d.claim).sort()).toEqual(['employed', 'incomeBelow32Median', 'isBenefitRecipient']);
    expect(welfare.denied.find((d) => d.claim === 'incomeBelow32Median')?.label).toBe('기준 중위소득 32% 이하 여부');
  });

  it('발급 가능한 사실은 두 기관 합쳐 13개 (대구광역시 5 + 사회보장정보원 8)', () => {
    expect(plans.flatMap((p) => p.issuable)).toHaveLength(13);
  });

  it("issuerOf 가 'self' 인 creditBottom20 은 어느 발급기관에도 요청하지 않고, 연소득 3,500만 원 이하는 사회보장정보원에 요청한다", () => {
    const requestedBy = (claim: string) => plans.filter((p) => [...p.issuable, ...p.denied].some((d) => d.claim === claim)).map((p) => p.did);
    expect(requestedBy('creditBottom20')).toEqual([]);
    expect(requestedBy('annualIncomeUnder35M')).toEqual(['did:dbp:welfare']);
    expect(requestedBy('annualIncomeUnder40M')).toEqual(['did:dbp:welfare']);
    // 발급 요청 본문(requestedClaims = issuable) 어디에도 creditBottom20 이 없다
    expect(plans.flatMap((p) => p.issuable.map((d) => d.claim))).not.toContain('creditBottom20');
  });

  it('창구가 직접 확인하는 항목: 신용평점 하위 20% (라벨은 번들 labels)', () => {
    const self = selfCheckedClaims(bundle, claims);
    expect(self).toEqual([{ claim: 'creditBottom20', label: '신용평점 하위 20% 여부 (창구 자체 조회)', value: true, issuerDid: 'self' }]);
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
  it('C-001 적격 정책은 data/expected.json 과 같다', () => {
    const eligible = buildRuleResults(bundle, claims)
      .filter((r) => r.eligible)
      .map((r) => r.policyId)
      .sort();
    expect(eligible).toEqual([...C001_ELIGIBLE].sort());
  });
  it('부적격 사유 라벨', () => {
    expect(failingClaimLabels(bundle, index['nbl-livelihood'], 'nbl-livelihood', claims)).toEqual(['기준 중위소득 32% 이하 여부']);
    expect(failingClaimLabels(bundle, index['nbl-education'], 'nbl-education', claims)).toEqual(['초·중·고 학생 자녀 유무']);
  });
});

describe('창구 종류별 분류 (김복례)', () => {
  const claims = computeClaims(bundle, c001);
  const eligible = new Set(buildRuleResults(bundle, claims).filter((r) => r.eligible).map((r) => r.policyId));
  const groups = groupEligibleByChannel(index, eligible);

  it('A. 은행·민간 창구: 서민금융 3종 + 민간 감면 3종 (finance → discount → 이름순)', () => {
    expect(groups.counter.map((p) => p.policyId)).toEqual(
      expect.arrayContaining(['sunshine-loan-general', 'new-hope-loan', 'micro-livelihood-loan', 'telecom-discount', 'electricity-welfare-discount', 'city-gas-discount']),
    );
    expect(groups.counter).toHaveLength(6);
    expect(groups.counter.slice(0, 3).every((p) => policyChannel(p) === 'finance')).toBe(true);
    expect(groups.counter.slice(3).every((p) => policyChannel(p) === 'discount')).toBe(true);
    const names = (from: number, to: number) => groups.counter.slice(from, to).map((p) => p.name);
    expect(names(0, 3)).toEqual([...names(0, 3)].sort((a, b) => a.localeCompare(b, 'ko')));
    expect(names(3, 6)).toEqual([...names(3, 6)].sort((a, b) => a.localeCompare(b, 'ko')));
  });

  it('B. 공공 복지·교통: 주거급여·차상위·기초연금·도시철도 무임 (복지멤버십 안내 대상)', () => {
    expect(groups.welfare.map((p) => p.policyId)).toEqual(expect.arrayContaining(['nbl-housing', 'near-poor', 'basic-pension', 'daegu-metro-free']));
    expect(groups.welfare).toHaveLength(4);
    expect(groups.welfare.every((p) => p.welfareMembership === true)).toBe(true);
    expect(groups.counter.every((p) => p.welfareMembership === false)).toBe(true);
  });

  it('두 그룹은 겹치지 않고 합치면 적격 정책 전체다', () => {
    const all = [...groups.counter, ...groups.welfare].map((p) => p.policyId);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...eligible].sort());
  });

  it('channel 이 없는 예전 정책 문서는 category 로 추정한다', () => {
    const legacy = (category: string): PolicyMeta => ({ ...index['new-hope-loan']!, channel: undefined, category });
    expect(policyChannel(legacy('금융'))).toBe('finance');
    expect(policyChannel(legacy('생활'))).toBe('discount');
    expect(policyChannel(legacy('교통'))).toBe('transport');
    expect(policyChannel(legacy('복지'))).toBe('welfare');
  });

  it("창구에 제출할 증명서: expected=true 이고 발급기관이 있는 claim 만 (self 제외), 소득 사실은 '사회보장정보원(복지기관)'", () => {
    expect(submitDocuments(bundle, index['sunshine-loan-general']!)).toEqual([
      { claim: 'annualIncomeUnder35M', label: '연소득 3,500만 원 이하 여부', issuerDid: 'did:dbp:welfare', issuerName: '사회보장정보원(복지기관)' },
    ]);
    // 새희망홀씨Ⅱ 는 연소득 4,000만 원 이하 증명서 1개
    expect(submitDocuments(bundle, index['new-hope-loan']!)).toEqual([
      { claim: 'annualIncomeUnder40M', label: '연소득 4,000만 원 이하 여부', issuerDid: 'did:dbp:welfare', issuerName: '사회보장정보원(복지기관)' },
    ]);
    expect(submitDocuments(bundle, index['telecom-discount']!).map((d) => [d.claim, d.issuerName])).toEqual([['incomeBelow50Median', '사회보장정보원(복지기관)']]);
    // expected=false (수급자 아님) 항목은 증명서가 아니다
    expect(submitDocuments(bundle, index['near-poor']!).map((d) => d.claim)).toEqual(['incomeBelow50Median']);
    // self 항목이 조합에 끼어 있어도 제출 목록에는 오르지 않는다 (옛 형식 requiredClaims 도 같다)
    const withSelf = legacyPolicy(index['new-hope-loan']!, [{ claim: 'annualIncomeUnder40M', expected: true }, { claim: 'creditBottom20', expected: true }]);
    expect(submitDocuments(bundle, withSelf).map((d) => d.claim)).toEqual(['annualIncomeUnder40M']);
    expect(counterChecks(bundle, withSelf)).toEqual([{ claim: 'creditBottom20', expected: true, label: '신용평점 하위 20% 여부' }]);
    for (const p of policies) expect(p.verifierHint).toBeTruthy();
  });
});

describe('증명 조합 고르기 (requiredClaimSets — 시민에게 맞는 조합)', () => {
  const eligibleOf = (claims: ReturnType<typeof computeClaims>) =>
    Object.fromEntries(buildRuleResults(bundle, claims).map((r) => [r.policyId, r.eligible]));
  const docs = (policyId: string, claims: ReturnType<typeof computeClaims>) =>
    submitDocuments(bundle, index[policyId]!, claims).map((d) => [d.claim, d.issuerName]);

  it('정책 문서의 조합 수: 서민금융·감면은 대체 경로, 나머지는 조합 하나', () => {
    const count = Object.fromEntries(policies.map((p) => [p.policyId, p.requiredClaimSets.length]));
    expect(count).toMatchObject({
      'sunshine-loan-general': 2,
      'new-hope-loan': 2,
      'micro-livelihood-loan': 3,
      'telecom-discount': 3,
      'electricity-welfare-discount': 2,
      'city-gas-discount': 2,
      'near-poor': 1,
      'basic-pension': 1,
    });
    for (const p of policies) expect(p).not.toHaveProperty('requiredClaims');
  });

  it('C-027 서혜진 (신용 하위 20%, 연소득 4,500만 원): 햇살론 일반보증은 연소득 4,500만 원 이하 증명서 + 창구가 신용평점 확인', () => {
    const claims = computeClaims(bundle, getCitizen('C-027')!);
    const ok = eligibleOf(claims);
    expect(ok['sunshine-loan-general']).toBe(true);
    expect(ok['new-hope-loan']).toBe(true);
    expect(docs('sunshine-loan-general', claims)).toEqual([['annualIncomeUnder45M', '사회보장정보원(복지기관)']]);
    expect(counterChecks(bundle, index['sunshine-loan-general']!, claims)).toEqual([{ claim: 'creditBottom20', expected: true, label: '신용평점 하위 20% 여부' }]);
    // 3,500만 원 이하 증명서는 발급조차 안 된다 — 첫 조합을 그대로 보여주면 안 되는 이유
    expect(claims['annualIncomeUnder35M']).toBe(false);
    expect(docs('sunshine-loan-general', claims).map(([c]) => c)).not.toContain('annualIncomeUnder35M');
    // 새희망홀씨도 신용 하위 20% 경로: 연소득 5,000만 원 이하
    expect(docs('new-hope-loan', claims)).toEqual([['annualIncomeUnder50M', '사회보장정보원(복지기관)']]);
    expect(counterChecks(bundle, index['new-hope-loan']!, claims).map((c) => c.claim)).toEqual(['creditBottom20']);
    // 보유 표시도 같은 조합 기준 (신용평점은 증명서가 아니므로 목록에 없다)
    expect(credentialHoldings(index['sunshine-loan-general']!, [], claims, bundle).map((h) => h.claim)).toEqual(['annualIncomeUnder45M']);
    // claims 를 모르면 선호 순 첫 조합
    expect(submitDocuments(bundle, index['sunshine-loan-general']!).map((d) => d.claim)).toEqual(['annualIncomeUnder35M']);
  });

  it('C-028 신종석 (신용 하위 20%, 연소득 45,000,001원): 새희망홀씨는 연소득 5,000만 원 이하, 햇살론 일반보증은 해당 없음', () => {
    const claims = computeClaims(bundle, getCitizen('C-028')!);
    const ok = eligibleOf(claims);
    expect(ok['new-hope-loan']).toBe(true);
    expect(ok['sunshine-loan-general']).toBe(false);
    expect(docs('new-hope-loan', claims)).toEqual([['annualIncomeUnder50M', '사회보장정보원(복지기관)']]);
    expect(counterChecks(bundle, index['new-hope-loan']!, claims)).toEqual([{ claim: 'creditBottom20', expected: true, label: '신용평점 하위 20% 여부' }]);
    // 부적격 사유: 두 조합 모두 한 항목씩 모자라면 앞선(선호) 조합 기준
    expect(failingClaimLabels(bundle, index['sunshine-loan-general'], 'sunshine-loan-general', claims)).toEqual(['연소득 3,500만 원 이하 여부 또는 연소득 4,500만 원 이하 여부']);
  });

  it('C-013 신정숙 (65세, 기초연금 선정기준액 이하, 수급자 아님): 통신요금 감면은 65세 이상 + 기초연금선 이하, 전기요금은 해당 없음', () => {
    const claims = computeClaims(bundle, getCitizen('C-013')!);
    expect(claims['isBenefitRecipient']).toBe(false);
    expect(claims['incomeBelow50Median']).toBe(false);
    const ok = eligibleOf(claims);
    expect(ok['telecom-discount']).toBe(true);
    expect(ok['electricity-welfare-discount']).toBe(false);
    expect(ok['city-gas-discount']).toBe(false);
    expect(docs('telecom-discount', claims)).toEqual([
      ['ageOver65', '대구광역시'],
      ['incomeBelowBasicPensionLine', '사회보장정보원(복지기관)'],
    ]);
    expect(counterChecks(bundle, index['telecom-discount']!, claims)).toEqual([]);
    // 한전 복지할인 대상에 기초연금 수급자는 없다 — 부적격 사유는 첫 조합(중위소득 50% 이하)
    expect(failingClaimLabels(bundle, index['electricity-welfare-discount'], 'electricity-welfare-discount', claims)).toEqual(['기준 중위소득 50% 이하 여부 또는 기초생활보장 급여 수급 여부']);
    // 창구 혜택 카드에는 통신요금만 오른다
    const eligible = new Set(Object.entries(ok).filter(([, v]) => v).map(([k]) => k));
    const counter = groupEligibleByChannel(index, eligible).counter.map((p) => p.policyId);
    expect(counter).toContain('telecom-discount');
    expect(counter).not.toContain('electricity-welfare-discount');
  });

  it('C-001 김복례: 햇살론 일반보증은 그대로 연소득 3,500만 원 이하 (신용평점 확인 불필요)', () => {
    const claims = computeClaims(bundle, c001);
    expect(docs('sunshine-loan-general', claims)).toEqual([['annualIncomeUnder35M', '사회보장정보원(복지기관)']]);
    expect(counterChecks(bundle, index['sunshine-loan-general']!, claims)).toEqual([]);
    expect(docs('new-hope-loan', claims)).toEqual([['annualIncomeUnder40M', '사회보장정보원(복지기관)']]);
    // 미소금융: 첫 조합(3,500만 이하 + 신용 하위 20%) — 증명서 1개, 신용평점은 창구 확인
    expect(docs('micro-livelihood-loan', claims)).toEqual([['annualIncomeUnder35M', '사회보장정보원(복지기관)']]);
    expect(counterChecks(bundle, index['micro-livelihood-loan']!, claims).map((c) => c.claim)).toEqual(['creditBottom20']);
    // 단일 조합 정책은 이전과 같다
    expect(docs('near-poor', claims).map(([c]) => c)).toEqual(['incomeBelow50Median']);
    expect(docs('basic-pension', claims).map(([c]) => c)).toEqual(['ageOver65', 'incomeBelowBasicPensionLine']);
  });

  it('C-002 박순자 (신용 하위 20% 아님, 중위소득 50% 이하): 미소금융은 셋째 조합 — 3,500만 이하 + 중위소득 50% 이하', () => {
    const claims = computeClaims(bundle, getCitizen('C-002')!);
    expect(claims['creditBottom20']).toBe(false);
    expect(eligibleOf(claims)['micro-livelihood-loan']).toBe(true);
    expect(docs('micro-livelihood-loan', claims).map(([c]) => c)).toEqual(['annualIncomeUnder35M', 'incomeBelow50Median']);
    expect(counterChecks(bundle, index['micro-livelihood-loan']!, claims)).toEqual([]);
  });

  it('C-022 (수급자): 차상위는 expected=false 항목 때문에 부적격 — "해당되어야 함: 아니오" 표시', () => {
    const claims = computeClaims(bundle, getCitizen('C-022')!);
    expect(claims['isBenefitRecipient']).toBe(true);
    expect(eligibleOf(claims)['near-poor']).toBe(false);
    expect(failingClaimLabels(bundle, index['near-poor'], 'near-poor', claims)).toEqual(['기초생활보장 급여 수급 여부 (해당되어야 함: 아니오)']);
  });

  it('옛 형식(requiredClaims 만 있는 캐시 문서)도 그대로 동작한다', () => {
    const claims = computeClaims(bundle, c001);
    const legacy = legacyPolicy(index['near-poor']!, [
      { claim: 'incomeBelow50Median', expected: true },
      { claim: 'isBenefitRecipient', expected: false },
    ]);
    expect(chooseClaimSet(legacy, claims)).toEqual(legacy.requiredClaims);
    expect(submitDocuments(bundle, legacy, claims).map((d) => d.claim)).toEqual(['incomeBelow50Median']);
    expect(credentialHoldings(legacy, [], claims, bundle).map((h) => [h.claim, h.held])).toEqual([
      ['incomeBelow50Median', false],
      ['isBenefitRecipient', true],
    ]);
    expect(counterChecks(bundle, legacy, claims)).toEqual([]);
    const c022 = computeClaims(bundle, getCitizen('C-022')!);
    expect(failingClaimLabels(bundle, legacy, 'near-poor', c022)).toEqual(['기초생활보장 급여 수급 여부 (해당되어야 함: 아니오)']);
    // 조합이 아예 없는 문서: 제출 증명서 없음, 부적격 사유는 규칙 변수
    const empty = legacyPolicy(index['nbl-livelihood']!, []);
    expect(chooseClaimSet(empty, claims)).toEqual([]);
    expect(submitDocuments(bundle, empty, claims)).toEqual([]);
    expect(failingClaimLabels(bundle, empty, 'nbl-livelihood', claims)).toEqual(['기준 중위소득 32% 이하 여부']);
  });
});

describe('추천 필터 (근거 없으면 비노출)', () => {
  const claims = computeClaims(bundle, c001);
  const eligible = new Set(buildRuleResults(bundle, claims).filter((r) => r.eligible).map((r) => r.policyId));
  const good: Recommendation = { policyId: 'new-hope-loan', headline: 'h', explanation: 'e', citations: ['new-hope-c1'], nextSteps: 'n', source: 'llm' };

  it('적격이 아닌 정책·없는 조항·없는 정책은 버린다', () => {
    const recs: Recommendation[] = [
      good,
      { ...good, policyId: 'nbl-livelihood', citations: ['nbl-livelihood-c1'] }, // 부적격
      { ...good, policyId: 'near-poor', citations: ['near-poor-c99'] }, // 없는 조항
      { ...good, policyId: 'ghost-policy', citations: ['x'] }, // 없는 정책
      { ...good, policyId: 'basic-pension', citations: [] }, // 인용 없음
      good, // 중복
    ];
    expect(filterRecommendations(recs, index, eligible).map((r) => r.policyId)).toEqual(['new-hope-loan']);
  });

  it('기본 상한이 없어 적격 정책 전부에 AI 설명을 붙일 수 있다', () => {
    const recs = [...eligible].map<Recommendation>((id) => ({ ...good, policyId: id, citations: [index[id]!.legalBasis[0]!.clauseId] }));
    expect(filterRecommendations(recs, index, eligible)).toHaveLength(eligible.size);
    expect(filterRecommendations(recs, index, eligible, 2)).toHaveLength(2);
  });

  it('AI 항목이 있으면 그것을, 없으면 템플릿 카드를 쓴다', () => {
    expect(pickRecommendation(index['new-hope-loan']!, [good])).toBe(good);
    const t = pickRecommendation(index['sunshine-loan-general']!, [good]);
    expect(t.source).toBe('template');
    expect(t).toEqual(templateRecommendation(index['sunshine-loan-general']!));
    expect(t.citations).toEqual(['sunshine-general-c1']);
    expect(t.explanation).toContain('규칙 엔진');
  });
});

describe('증명서 보유 표시', () => {
  const claims = computeClaims(bundle, c001);
  const creds: StoredCredential[] = [
    {
      jti: '1',
      claim: 'incomeBelow50Median',
      label: '',
      value: true,
      vcJwt: 'a',
      issuerDid: 'did:dbp:welfare',
      issuerName: '사회보장정보원(복지기관)',
      statusListIndex: 0,
      validUntil: '',
      issuedAt: '',
    },
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
  it("issuerOf 가 'self' 인 항목은 보유 목록에 오르지 않는다", () => {
    const withSelf = legacyPolicy(index['new-hope-loan']!, [{ claim: 'annualIncomeUnder40M', expected: true }, { claim: 'creditBottom20', expected: true }]);
    expect(credentialHoldings(withSelf, creds, claims, bundle).map((x) => x.claim)).toEqual(['annualIncomeUnder40M']);
    // 2026.2 문서: 김복례(신용 하위 20%, 연소득 1,200만 원)는 첫 조합(연소득 3,500만 원 이하)으로 충족 — 신용평점은 목록에 없다
    expect(credentialHoldings(index['micro-livelihood-loan']!, creds, claims, bundle).map((x) => x.claim)).toEqual(['annualIncomeUnder35M']);
  });
});

describe('조사', () => {
  it('받침에 따라 이/가', () => {
    expect(josa('서민금융통합지원센터 대구센터 창구직원', '이/가')).toBe('서민금융통합지원센터 대구센터 창구직원이');
    expect(josa('대구 북구 행정복지센터', '이/가')).toBe('대구 북구 행정복지센터가');
    expect(josa('ABC', '이/가')).toBe('ABC이');
  });
});
