/**
 * tests/test_bundle_consistency.py (조합 부분) · test_policy_partial.py (claim_sets) 의 미러.
 *
 * requiredClaimSets 는 '정책을 참으로 만드는 증명 조합'의 anyOf 다. 지갑은 이 조합으로 제출할 증명서를 고른다.
 * 그래서 조합마다 (1) 그것만으로 규칙이 참이 되고(충분), 어느 항목을 빼면 확정되지 않으며(최소),
 * (2) 조합을 모두 합치면 규칙이 참인 경우를 빠짐없이 덮어야(필요) 한다.
 * TS 에는 부분 판정기가 없으므로 규칙 변수의 참/거짓 전체 조합을 evaluate 로 직접 돌려 확인한다.
 */
import { describe, expect, it } from 'vitest';
import {
  claimSetsOf,
  evaluate,
  loadBundle,
  loadPolicies,
  policyIndex,
  repoRoot,
  type PolicyMeta,
  type RequiredClaim,
  type Rule,
} from '../src/node.js';

const ROOT = repoRoot();
const BUNDLE = loadBundle(ROOT);
const RULES = BUNDLE.policies.rules;
const METAS = policyIndex(loadPolicies(ROOT));
const PIDS = Object.keys(RULES).sort();

/** 규칙이 참조하는 var 이름 (정렬). */
function ruleVars(rule: Rule, acc = new Set<string>()): string[] {
  const walk = (r: Rule): void => {
    if (Array.isArray(r)) r.forEach(walk);
    else if (r !== null && typeof r === 'object') {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'var') acc.add(typeof v === 'string' ? v : String((v as Rule[])[0]));
        else walk(v as Rule);
      }
    }
  };
  walk(rule);
  return [...acc].sort();
}

/** names 의 참/거짓 모든 조합 (2^n). */
function assignments(names: readonly string[]): Array<Record<string, boolean>> {
  const out: Array<Record<string, boolean>> = [];
  for (let bits = 0; bits < 1 << names.length; bits++) {
    out.push(Object.fromEntries(names.map((n, i) => [n, (bits >> i) % 2 === 1])));
  }
  return out;
}

const matches = (set: readonly RequiredClaim[], a: Record<string, boolean>): boolean => set.every((rc) => a[rc.claim] === rc.expected);

function ruleTrue(pid: string, a: Record<string, boolean>): boolean {
  const v = evaluate(RULES[pid]!, a);
  if (typeof v !== 'boolean') throw new TypeError(`policy ${pid} must evaluate to boolean`);
  return v;
}

/** known 만 알 때 판정이 참으로 확정되는가 = 규칙의 나머지 변수를 어떻게 채워도 참인가. */
function decidedTrue(pid: string, known: readonly RequiredClaim[]): boolean {
  const fixed = Object.fromEntries(known.map((rc) => [rc.claim, rc.expected]));
  const unknown = ruleVars(RULES[pid]!).filter((n) => !(n in fixed));
  return assignments(unknown).every((fill) => ruleTrue(pid, { ...fill, ...fixed }));
}

const pairs = (set: readonly RequiredClaim[]): string[] => set.map((rc) => `${rc.claim}=${rc.expected}`).sort();

describe('requiredClaimSets ↔ 번들 규칙 (전체 조합 확인)', () => {
  it.each(PIDS)('%s: 조합 하나만으로 참이 확정되고(충분), 어느 항목을 빼도 확정되지 않는다(최소)', (pid) => {
    const sets = claimSetsOf(METAS[pid]!);
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(decidedTrue(pid, set), `${pid} ${pairs(set)}`).toBe(true);
      for (const drop of set) {
        const rest = set.filter((rc) => rc !== drop);
        expect(decidedTrue(pid, rest), `${pid} ${pairs(set)} - ${drop.claim}`).toBe(false);
      }
    }
    // 다른 조합을 포함하는 조합은 두지 않는다
    for (const a of sets) {
      for (const b of sets) {
        if (a === b) continue;
        const pa = pairs(a);
        const pb = pairs(b);
        const bInsideA = pb.length < pa.length && pb.every((x) => pa.includes(x));
        expect(bInsideA, `${pid}: [${pb}] ⊂ [${pa}]`).toBe(false);
      }
    }
  });

  it.each(PIDS)('%s: 규칙 변수의 모든 참/거짓 조합에서 규칙이 참 ⇔ 어떤 조합과 일치한다(필요)', (pid) => {
    const sets = claimSetsOf(METAS[pid]!);
    for (const a of assignments(ruleVars(RULES[pid]!))) {
      const covered = sets.some((set) => matches(set, a));
      expect(ruleTrue(pid, a), `${pid} ${JSON.stringify(a)}`).toBe(covered);
    }
  });

  it('여러 경로가 있는 정책의 조합과 순서 (앞쪽이 창구가 먼저 권하는 경로)', () => {
    const plain = (pid: string) => claimSetsOf(METAS[pid]!).map((s) => s.map((rc) => [rc.claim, rc.expected]));
    expect(plain('sunshine-loan-general')).toEqual([
      [['annualIncomeUnder35M', true]],
      [['creditBottom20', true], ['annualIncomeUnder45M', true]],
    ]);
    expect(plain('new-hope-loan')).toEqual([
      [['annualIncomeUnder40M', true]],
      [['creditBottom20', true], ['annualIncomeUnder50M', true]],
    ]);
    expect(plain('micro-livelihood-loan')).toEqual([
      [['annualIncomeUnder35M', true], ['creditBottom20', true]],
      [['annualIncomeUnder35M', true], ['isBenefitRecipient', true]],
      [['annualIncomeUnder35M', true], ['incomeBelow50Median', true]],
    ]);
    expect(plain('telecom-discount')).toEqual([
      [['incomeBelow50Median', true]],
      [['isBenefitRecipient', true]],
      [['ageOver65', true], ['incomeBelowBasicPensionLine', true]],
    ]);
    for (const pid of ['electricity-welfare-discount', 'city-gas-discount']) {
      expect(plain(pid), pid).toEqual([[['incomeBelow50Median', true]], [['isBenefitRecipient', true]]]);
    }
    expect(plain('near-poor')).toEqual([[['incomeBelow50Median', true], ['isBenefitRecipient', false]]]);
    const multi = new Set(['sunshine-loan-general', 'new-hope-loan', 'micro-livelihood-loan', 'telecom-discount', 'electricity-welfare-discount', 'city-gas-discount']);
    for (const pid of PIDS.filter((p) => !multi.has(p))) expect(claimSetsOf(METAS[pid]!), pid).toHaveLength(1);
  });

  it("issuerOf 'self'(신용평점) 항목은 반드시 발급기관이 증명하는 항목과 함께 나온다", () => {
    const issuerOf = BUNDLE.claims.issuerOf;
    for (const pid of PIDS) {
      for (const set of claimSetsOf(METAS[pid]!)) {
        expect(set.some((rc) => issuerOf[rc.claim] !== 'self'), `${pid} ${pairs(set)}`).toBe(true);
      }
    }
  });

  it('verifierHint 는 대체 경로가 있는 서민금융·통신요금 정책에서 그 경로를 안내한다', () => {
    expect(METAS['sunshine-loan-general']!.verifierHint).toMatch(/4,500만/);
    expect(METAS['new-hope-loan']!.verifierHint).toMatch(/5,000만/);
    expect(METAS['micro-livelihood-loan']!.verifierHint).toMatch(/기초생활보장 급여 수급|중위소득 50%/);
    expect(METAS['telecom-discount']!.verifierHint).toMatch(/기초연금/);
  });
});

describe('claimSetsOf (Python claim_sets)', () => {
  const legacy: RequiredClaim[] = [{ claim: 'annualIncomeUnder35M', expected: true }];
  const asMeta = (o: object) => o as Pick<PolicyMeta, 'requiredClaimSets' | 'requiredClaims'>;

  it('지갑 캐시에 남은 2026.2 이전 문서(requiredClaims 단일 목록)는 조합 하나로 읽는다', () => {
    expect(claimSetsOf(asMeta({ requiredClaims: legacy }))).toEqual([legacy]);
    expect(claimSetsOf(asMeta({ requiredClaims: [] }))).toEqual([]);
    expect(claimSetsOf(asMeta({}))).toEqual([]);
  });

  it('새 형식이 있으면 그것이 우선', () => {
    const sets: RequiredClaim[][] = [[{ claim: 'annualIncomeUnder40M', expected: true }]];
    expect(claimSetsOf(asMeta({ requiredClaimSets: sets, requiredClaims: legacy }))).toBe(sets);
    expect(claimSetsOf(asMeta({ requiredClaimSets: [], requiredClaims: legacy }))).toEqual([]);
  });
});
