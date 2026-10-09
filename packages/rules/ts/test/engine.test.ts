/** tests/test_engine_matches_expected.py + test_bundle_consistency.py 의 미러. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleHash,
  canonicalize,
  categoricalProfile,
  evaluateClaims,
  evaluatePolicies,
  loadBundle,
  loadCitizens,
  loadPolicies,
  policyIndex,
  repoRoot,
  type ClaimMap,
  type Json,
  type Rule,
} from '../src/node.js';

interface ExpectedRow { citizenId: string; claims: Record<string, boolean>; policies: Record<string, boolean> }
interface Expected {
  evalDate: string; bundle: string; version: string; bundleHash: string;
  citizenCount: number; policyCount: number; verdictCount: number; rows: ExpectedRow[];
}

const ROOT = repoRoot();
const EXPECTED = JSON.parse(readFileSync(join(ROOT, 'data/expected.json'), 'utf-8')) as Expected;
const CITIZENS = Object.fromEntries(loadCitizens(ROOT).map((c) => [c.citizenId, c]));
const BUNDLE = loadBundle(ROOT);
const CLAIM_NAMES = new Set(Object.keys(BUNDLE.claims.rules));

/** 규칙이 참조하는 var 이름 집합 (test_bundle_consistency._vars). */
function vars(rule: Rule, acc = new Set<string>()): Set<string> {
  if (Array.isArray(rule)) rule.forEach((v) => vars(v, acc));
  else if (rule !== null && typeof rule === 'object') {
    for (const [k, v] of Object.entries(rule)) {
      if (k === 'var') acc.add(typeof v === 'string' ? v : String((v as Json[])[0]));
      else vars(v, acc);
    }
  }
  return acc;
}

describe('engine matches data/expected.json', () => {
  it('bundle hash equals expected.json (TS/Python canonicalization parity)', () => {
    expect(BUNDLE.bundle).toBe(EXPECTED.bundle);
    expect(BUNDLE.version).toBe(EXPECTED.version);
    expect(bundleHash(BUNDLE)).toBe(EXPECTED.bundleHash);
  });

  it('composeBundle has the same shape as Python compose_bundle', () => {
    expect(Object.keys(BUNDLE)).toEqual(['bundle', 'version', 'preprocess', 'claims', 'policies', 'tables']);
    expect(Object.keys(BUNDLE.tables).sort()).toEqual(
      ['basicPensionLineByHouseholdKind', 'medianIncomeByHouseholdSize', 'medianIncomeSource', 'medianIncomeYear'],
    );
    expect(BUNDLE.tables.medianIncomeYear).toBe(2026);
    expect(BUNDLE.tables.basicPensionLineByHouseholdKind).toEqual({ single: 2470000, couple: 3952000 });
  });

  it('all 30 citizens x 13 policies match (claims and policies)', () => {
    const mismatches: unknown[] = [];
    for (const row of EXPECTED.rows) {
      const c = CITIZENS[row.citizenId]!;
      const claims = evaluateClaims(BUNDLE, c, EXPECTED.evalDate);
      const policies = evaluatePolicies(BUNDLE, claims);
      if (JSON.stringify(claims) !== JSON.stringify(row.claims)) mismatches.push([row.citizenId, 'claims', claims, row.claims]);
      if (JSON.stringify(policies) !== JSON.stringify(row.policies)) mismatches.push([row.citizenId, 'policies', policies, row.policies]);
    }
    expect(mismatches).toEqual([]);
    expect(EXPECTED.rows.length).toBe(30);
    expect(EXPECTED.citizenCount).toBe(30);
    expect(EXPECTED.policyCount).toBe(Object.keys(BUNDLE.policies.rules).length);
    expect(EXPECTED.verdictCount).toBeGreaterThanOrEqual(150);
  });

  it('persona C-001 outcome and categorical profile (no raw numbers leak)', () => {
    const c = CITIZENS['C-001']!;
    const claims = evaluateClaims(BUNDLE, c, '2026-09-14');
    const pol = evaluatePolicies(BUNDLE, claims);
    expect(claims['daeguResident'] && claims['incomeBelow50Median'] && claims['ageOver65']).toBe(true);
    expect(claims['incomeBelow32Median']).toBe(false);
    expect(pol['nbl-housing'] && pol['basic-pension'] && pol['daegu-metro-free'] && pol['micro-livelihood-loan']).toBe(true);
    expect(pol['nbl-livelihood'] || pol['nbl-education'] || pol['energy-voucher']).toBe(false);
    const cat = categoricalProfile(claims, c.householdSize);
    expect(cat).toEqual({
      ageBand: '65+', householdSize: 1, residence: 'daegu', incomeBracket: '≤48%',
      recipientStatus: 'near-poor', creditTier: 'bottom20',
    });
    const s = JSON.stringify(cat);
    expect(s).not.toContain('monthlyIncomeKRW');
    expect(s).not.toContain('1000000');
  });

  it('policies evaluate from claims only (verifier needs no profile)', () => {
    const claims: ClaimMap = Object.fromEntries([...CLAIM_NAMES].map((k) => [k, false]));
    claims['daeguResident'] = true;
    claims['incomeBelow50Median'] = true;
    const pol = evaluatePolicies(BUNDLE, claims);
    expect(pol['telecom-discount']).toBe(true);
    expect(pol['near-poor']).toBe(true);
    expect(pol['nbl-housing']).toBe(false);
  });

  it('age is a calendar (y,m,d) comparison; string and Date as-of agree', () => {
    const c13 = CITIZENS['C-013']!; // 1961-09-14 → 65 on the eval date
    const c14 = CITIZENS['C-014']!; // 1961-09-15 → 64
    expect(evaluateClaims(BUNDLE, c13, '2026-09-14')['ageOver65']).toBe(true);
    expect(evaluateClaims(BUNDLE, c14, '2026-09-14')['ageOver65']).toBe(false);
    expect(evaluateClaims(BUNDLE, c14, '2026-09-15')['ageOver65']).toBe(true);
    expect(evaluateClaims(BUNDLE, c13, new Date('2026-09-14'))).toEqual(evaluateClaims(BUNDLE, c13, '2026-09-14'));
    expect(() => evaluateClaims(BUNDLE, c13, '2026-02-30')).toThrow(/invalid date/);
    expect(() => evaluateClaims(BUNDLE, c13, '14/09/2026')).toThrow(/invalid ISO date/);
  });

  it('evaluateClaims keeps rule order, honors `only`, and does not mutate the profile', () => {
    const c = CITIZENS['C-001']!;
    const before = JSON.stringify(c);
    const claims = evaluateClaims(BUNDLE, c);
    expect(Object.keys(claims)).toEqual(Object.keys(BUNDLE.claims.rules));
    expect(Object.keys(evaluateClaims(BUNDLE, c, undefined, ['ageOver65']))).toEqual(['ageOver65']);
    expect(Object.keys(evaluateClaims(BUNDLE, c, undefined, []))).toEqual(Object.keys(BUNDLE.claims.rules));
    expect(() => evaluateClaims(BUNDLE, c, undefined, ['nope'])).toThrow(/unknown claim/);
    expect(JSON.stringify(c)).toBe(before);
  });

  it('categoricalProfile clamps household size and maps brackets', () => {
    const base: ClaimMap = { ageOver65: false, daeguResident: false, creditBottom20: false, isBenefitRecipient: true,
      incomeBelow32Median: true, incomeBelow48Median: true, incomeBelow50Median: true };
    expect(categoricalProfile(base, 9)).toEqual({ ageBand: '<65', householdSize: 6, residence: 'other',
      incomeBracket: '≤32%', recipientStatus: 'recipient', creditTier: 'other' });
    expect(categoricalProfile({}, 0)).toEqual({ ageBand: '<65', householdSize: 1, residence: 'other',
      incomeBracket: '>50%', recipientStatus: 'none', creditTier: 'other' });
  });
});

describe('bundle / policy metadata consistency', () => {
  it('policy rules reference existing claims', () => {
    for (const [pid, rule] of Object.entries(BUNDLE.policies.rules)) {
      const used = vars(rule);
      expect([...used].filter((v) => !CLAIM_NAMES.has(v)), pid).toEqual([]);
    }
  });

  it('policy metadata matches the bundle', () => {
    const metas = loadPolicies(ROOT);
    const idx = policyIndex(metas);
    expect(Object.keys(idx).sort()).toEqual(Object.keys(BUNDLE.policies.rules).sort());
    for (const p of metas) {
      const used = vars(BUNDLE.policies.rules[p.policyId]!);
      for (const rc of p.requiredClaims) expect(used.has(rc.claim), `${p.policyId}:${rc.claim}`).toBe(true);
      expect(p.legalBasis.length).toBeGreaterThan(0);
      for (const lb of p.legalBasis) expect(lb.sourceUrl.startsWith('http')).toBe(true);
    }
  });

  it('issuer map and labels cover all claims', () => {
    expect(Object.keys(BUNDLE.claims.issuerOf).sort()).toEqual([...CLAIM_NAMES].sort());
    expect(Object.keys(BUNDLE.claims.labels).sort()).toEqual([...CLAIM_NAMES].sort());
  });

  it('no floats anywhere', () => {
    expect(() => canonicalize(BUNDLE)).not.toThrow();
    expect(() => canonicalize(JSON.parse(readFileSync(join(ROOT, 'data/citizens.json'), 'utf-8')))).not.toThrow();
  });

  it('core entry is browser-safe (no Node-only imports outside node.ts)', () => {
    const srcDir = join(ROOT, 'packages/rules/ts/src');
    for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== 'node.ts')) {
      const text = readFileSync(join(srcDir, f), 'utf-8');
      expect(text, f).not.toMatch(/from ['"]node:|from ['"](fs|path|url|os)['"]|\bprocess\.|import\.meta/);
    }
  });

  it('partial profile: bank evaluates only its own claims (Python parity)', () => {
    const bank = { creditScoreTier: 'bottom20', annualIncomeKRW: 12_000_000 };
    expect(evaluateClaims(BUNDLE, bank, '2026-09-14', ['creditBottom20', 'annualIncomeUnder35M'])).toEqual({
      creditBottom20: true,
      annualIncomeUnder35M: true,
    });
    expect(() => evaluateClaims(BUNDLE, bank, '2026-09-14', ['incomeBelow50Median'])).toThrow(TypeError);
  });
});
