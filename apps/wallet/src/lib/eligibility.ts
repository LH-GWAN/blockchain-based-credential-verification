/**
 * 규칙 엔진·AI 페이로드·VC 선택 헬퍼. 모두 순수 함수 (네트워크·저장소 없음).
 * 판정(적격/부적격)은 전부 @dbp/rules 의 결정론적 엔진 출력이며 AI 출력이 아니다.
 */
import { bundleHash, categoricalProfile, evaluateClaims, evaluatePolicies } from '@dbp/rules';
import type { Json, JsonObject } from '@dbp/rules';
import citizensJson from '@/generated/citizens.json';
import { EVAL_DATE, ISSUERS } from './env';
import type {
  Bundle,
  CategoricalProfile,
  CitizenProfile,
  ClaimMap,
  LegalBasis,
  PolicyMeta,
  RecommendPayload,
  Recommendation,
  RequestedClaim,
  RuleResult,
  StoredCredential,
} from './types';

// ---------- 합성 시민 ----------

export const CITIZENS: readonly CitizenProfile[] = (citizensJson as unknown as { citizens: CitizenProfile[] }).citizens;

export function getCitizen(citizenId: string): CitizenProfile | undefined {
  return CITIZENS.find((c) => c.citizenId === citizenId);
}

/** 기준일 기준 만 나이 (엔진 preprocess 와 동일 규칙). */
export function ageOn(birthDate: string, asOf: string = EVAL_DATE): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [y, m, d] = asOf.split('-').map(Number) as [number, number, number];
  let years = y - by;
  if (m < bm || (m === bm && d < bd)) years -= 1;
  return years;
}

export interface CitizenSummary {
  citizenId: string;
  name: string;
  sigungu: string;
  householdSize: number;
  ageBand: string;
}

/** 드롭다운 표시용: 이름 · 구 · 가구원수 · 연령대 (소득은 절대 표시하지 않는다). */
export function citizenSummary(c: CitizenProfile): CitizenSummary {
  const age = ageOn(c.birthDate);
  return {
    citizenId: c.citizenId,
    name: c.name,
    sigungu: c.residence.sigungu,
    householdSize: c.householdSize,
    ageBand: `${Math.floor(age / 10) * 10}대`,
  };
}

// ---------- claim 판정 (로컬) ----------

export function computeClaims(bundle: Bundle, profile: CitizenProfile): ClaimMap {
  return evaluateClaims(bundle, profile as unknown as JsonObject, EVAL_DATE);
}

export function claimLabel(bundle: Bundle, claim: string): string {
  return bundle.claims.labels[claim] ?? claim;
}

export interface ClaimDecision {
  claim: string;
  label: string;
  value: boolean;
  issuerDid: string;
}

export interface IssuerPlan {
  did: string;
  name: string;
  url: string;
  issuable: ClaimDecision[];
  denied: ClaimDecision[];
}

/** 발급기관별(대구광역시 → iM뱅크) 발급 가능/불가 목록. issuerOf 에 없는 claim 은 제외. */
export function planByIssuer(bundle: Bundle, claims: ClaimMap): IssuerPlan[] {
  return ISSUERS.map((iss) => {
    const mine = Object.entries(bundle.claims.issuerOf)
      .filter(([, did]) => did === iss.did)
      .map(([claim]) => claim)
      .filter((claim) => claim in claims);
    const decisions = mine.map<ClaimDecision>((claim) => ({
      claim,
      label: claimLabel(bundle, claim),
      value: claims[claim] === true,
      issuerDid: iss.did,
    }));
    return {
      did: iss.did,
      name: iss.name,
      url: iss.url,
      issuable: decisions.filter((d) => d.value),
      denied: decisions.filter((d) => !d.value),
    };
  });
}

export interface HashCheck {
  local: string;
  declared: string | null;
  ok: boolean;
}

/** 지갑이 받은 번들을 직접 해시해 발급기관이 알린 해시와 대조한다 (불변 조건 4). */
export function checkBundleHash(bundle: Bundle, declared: string | null | undefined): HashCheck {
  const local = bundleHash(bundle);
  const d = declared ?? null;
  return { local, declared: d, ok: d !== null && d.toLowerCase() === local.toLowerCase() };
}

// ---------- 정책 판정 → ruleResults ----------

/** 규칙을 걸어 `{var: name}` 을 모두 모은다 (출현 순, 중복 제거). */
export function ruleVars(rule: Json): string[] {
  const out: string[] = [];
  const walk = (r: Json): void => {
    if (Array.isArray(r)) {
      r.forEach(walk);
      return;
    }
    if (!r || typeof r !== 'object') return;
    for (const [op, args] of Object.entries(r)) {
      if (op === 'var') {
        const name = Array.isArray(args) ? args[0] : args;
        if (typeof name === 'string' && !out.includes(name)) out.push(name);
      } else {
        walk(args);
      }
    }
  };
  walk(rule);
  return out;
}

export function evaluatePolicyMap(bundle: Bundle, claims: ClaimMap): Record<string, boolean> {
  return evaluatePolicies(bundle, claims);
}

/** policyId, 적격 여부(규칙 엔진), 규칙이 참조한 claim 중 참인 것. */
export function buildRuleResults(bundle: Bundle, claims: ClaimMap): RuleResult[] {
  const policyMap = evaluatePolicies(bundle, claims);
  return Object.entries(bundle.policies.rules).map(([policyId, rule]) => ({
    policyId,
    eligible: policyMap[policyId] === true,
    matchedClaims: ruleVars(rule).filter((v) => claims[v] === true),
  }));
}

// ---------- AI 페이로드 (범주값 allowlist) ----------

const CATEGORICAL_KEYS = ['ageBand', 'householdSize', 'residence', 'incomeBracket', 'recipientStatus', 'creditTier'] as const;

export function buildCategoricalProfile(claims: ClaimMap, householdSize: number): CategoricalProfile {
  const full = categoricalProfile(claims, householdSize);
  // 라이브러리가 바뀌더라도 지갑은 6개 필드만 내보낸다.
  const picked: Partial<CategoricalProfile> = {};
  for (const k of CATEGORICAL_KEYS) (picked as Record<string, unknown>)[k] = full[k];
  return picked as CategoricalProfile;
}

/** /recommend · /chat 공통 본문. 원본 프로필 필드는 어디에도 실리지 않는다. */
export function buildRecommendPayload(bundle: Bundle, profile: CitizenProfile): RecommendPayload {
  const claims = computeClaims(bundle, profile);
  return {
    categoricalProfile: buildCategoricalProfile(claims, profile.householdSize),
    ruleResults: buildRuleResults(bundle, claims),
    locale: 'ko',
  };
}

// ---------- VC 선택 (제출) ----------

export interface VcSelection {
  vcJwts: string[];
  matched: Array<{ claim: string; expected: boolean; credential: StoredCredential }>;
  missing: RequestedClaim[];
}

/** 요청된 claim 과 expected 가 정확히 일치하는 VC 만 고른다 (원자적 VC = 선택적 공개). */
export function selectVcsForRequest(credentials: readonly StoredCredential[], requested: readonly RequestedClaim[]): VcSelection {
  const matched: VcSelection['matched'] = [];
  const missing: RequestedClaim[] = [];
  for (const req of requested) {
    const expected = req.expected !== false;
    const found = credentials.find((c) => c.claim === req.claim && c.value === expected);
    if (found) matched.push({ claim: req.claim, expected, credential: found });
    else missing.push({ ...req, expected });
  }
  return { vcJwts: matched.map((m) => m.credential.vcJwt), matched, missing };
}

// ---------- 정책 카드 보조 ----------

export interface Holding {
  claim: string;
  expected: boolean;
  label: string;
  held: boolean;
  note?: string;
}

/**
 * 정책 requiredClaims 대비 보유 증명서. expected=false 항목은 증명서가 존재할 수 없으므로
 * (발급기관은 참인 사실만 발급) 로컬 판정이 거짓이고 참 증명서가 없으면 "해당 없음 확인" 으로 표시한다.
 */
export function credentialHoldings(
  policy: PolicyMeta,
  credentials: readonly StoredCredential[],
  claims: ClaimMap,
  bundle: Bundle,
): Holding[] {
  return policy.requiredClaims.map((rc) => {
    const label = claimLabel(bundle, rc.claim);
    if (rc.expected) {
      return { claim: rc.claim, expected: true, label, held: credentials.some((c) => c.claim === rc.claim && c.value) };
    }
    const hasTrueVc = credentials.some((c) => c.claim === rc.claim && c.value);
    return {
      claim: rc.claim,
      expected: false,
      label,
      held: !hasTrueVc && claims[rc.claim] === false,
      note: '해당 없음 확인 (증명서 불필요)',
    };
  });
}

/** 부적격 정책에서 충족되지 않은 claim 라벨. requiredClaims 우선, 없으면 규칙 변수. */
export function failingClaimLabels(bundle: Bundle, policy: PolicyMeta | undefined, policyId: string, claims: ClaimMap): string[] {
  if (policy && policy.requiredClaims.length > 0) {
    const bad = policy.requiredClaims.filter((rc) => (claims[rc.claim] === true) !== rc.expected);
    if (bad.length > 0) return bad.map((rc) => (rc.expected ? claimLabel(bundle, rc.claim) : `${claimLabel(bundle, rc.claim)} (해당되어야 함: 아니오)`));
  }
  const rule = bundle.policies.rules[policyId];
  if (rule === undefined) return [];
  return ruleVars(rule)
    .filter((v) => claims[v] !== true)
    .map((v) => claimLabel(bundle, v));
}

export function resolveCitations(policy: PolicyMeta | undefined, citations: readonly string[]): LegalBasis[] {
  if (!policy) return [];
  return citations
    .map((id) => policy.legalBasis.find((b) => b.clauseId === id))
    .filter((b): b is LegalBasis => b !== undefined);
}

/** AI 없이도 카드가 비지 않도록 정책 문서를 그대로 문장화한다 (services/ai template 과 같은 구조). */
export function templateRecommendation(policy: PolicyMeta): Recommendation {
  const clause = policy.legalBasis[0];
  return {
    policyId: policy.policyId,
    headline: `${policy.name} — 신청하실 수 있습니다`,
    explanation: `${policy.summary} 규칙 엔진이 확인한 결과, 이 제도의 신청 기준을 충족합니다.${clause ? ` 근거는 ${clause.title}입니다.` : ''}`,
    citations: clause ? [clause.clauseId] : [],
    nextSteps: `${policy.howToApply}. 최종 수급 여부는 담당 기관 심사로 정해집니다.`,
    source: 'template',
  };
}

/**
 * 불변 조건 7 (근거 없으면 비노출) 을 지갑에서도 강제한다:
 * 규칙 엔진이 적격으로 판정하지 않았거나, 인용 조항이 정책 DB 에 실재하지 않으면 그 항목은 버린다.
 */
export function filterRecommendations(
  recs: readonly Recommendation[],
  index: Record<string, PolicyMeta>,
  eligibleIds: ReadonlySet<string>,
  limit = 3,
): Recommendation[] {
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  for (const r of recs) {
    if (seen.has(r.policyId) || !eligibleIds.has(r.policyId)) continue;
    const policy = index[r.policyId];
    if (!policy) continue;
    if (r.citations.length === 0 || resolveCitations(policy, r.citations).length !== r.citations.length) continue;
    seen.add(r.policyId);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

const CATEGORY_RANK: Record<string, number> = { 복지: 0, 금융: 1, 교통: 2 };

/** 적격 정책을 템플릿 카드로 채운다 (AI 응답이 비거나 서비스가 없을 때). */
export function fillWithTemplates(
  current: readonly Recommendation[],
  index: Record<string, PolicyMeta>,
  eligibleIds: ReadonlySet<string>,
  limit = 3,
): Recommendation[] {
  const out = [...current];
  const have = new Set(out.map((r) => r.policyId));
  const rest = [...eligibleIds]
    .filter((id) => !have.has(id) && index[id])
    .map((id) => index[id] as PolicyMeta)
    .sort((a, b) => (CATEGORY_RANK[a.category] ?? 3) - (CATEGORY_RANK[b.category] ?? 3) || a.policyId.localeCompare(b.policyId));
  for (const p of rest) {
    if (out.length >= limit) break;
    out.push(templateRecommendation(p));
  }
  return out;
}

// ---------- 한국어 조사 ----------

/** 받침 유무로 이/가, 을/를, 은/는 을 고른다. 한글이 아니면 앞 형태. */
export function josa(word: string, pair: '이/가' | '을/를' | '은/는'): string {
  const [withBatchim, without] = pair.split('/') as [string, string];
  const last = word.trimEnd().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    return word + ((code - 0xac00) % 28 === 0 ? without : withBatchim);
  }
  return word + withBatchim;
}
