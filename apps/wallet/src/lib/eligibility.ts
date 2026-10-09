/**
 * 규칙 엔진·AI 페이로드·VC 선택 헬퍼. 모두 순수 함수 (네트워크·저장소 없음).
 * 판정(적격/부적격)은 전부 @dbp/rules 의 결정론적 엔진 출력이며 AI 출력이 아니다.
 */
import { bundleHash, categoricalProfile, claimSetsOf, evaluateClaims, evaluatePolicies } from '@dbp/rules';
import type { Json, JsonObject } from '@dbp/rules';
import { decodeVc } from '@dbp/vc';
import citizensJson from '@/generated/citizens.json';
import { EVAL_DATE, SELF_ISSUER, issuerByDid, issuerName } from './env';
import type { LedgerBundle } from './ledger';
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
  RequiredClaim,
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

/** evalDate: 발급기관이 알린 기준일(bundle.evalDate). 없으면 기본 기준일 — 발급기관 판정과 같은 날짜로 계산해야 결과가 같다 (F65). */
export function computeClaims(bundle: Bundle, profile: CitizenProfile, evalDate: string = EVAL_DATE): ClaimMap {
  return evaluateClaims(bundle, profile as unknown as JsonObject, evalDate);
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

/** 번들 issuerOf 에 등장하는 발급기관 DID (출현 순, 중복 제거). 'self' 는 발급기관이 아니므로 제외. */
export function issuerDidsInOrder(bundle: Bundle): string[] {
  const out: string[] = [];
  for (const did of Object.values(bundle.claims.issuerOf)) {
    if (did === SELF_ISSUER || out.includes(did)) continue;
    out.push(did);
  }
  return out;
}

/** 이 claim 은 증명서로 발급되지 않고 창구가 직접 확인한다 (issuerOf === 'self'). */
export function isSelfChecked(bundle: Bundle, claim: string): boolean {
  return bundle.claims.issuerOf[claim] === SELF_ISSUER;
}

/**
 * 발급기관별(대구광역시 → 사회보장정보원, issuerOf 출현 순) 발급 가능/불가 목록.
 * issuerOf 에 없는 claim, issuerOf 가 'self' 인 claim, 지갑이 주소를 모르는 발급기관은 제외한다.
 */
export function planByIssuer(bundle: Bundle, claims: ClaimMap): IssuerPlan[] {
  const plans: IssuerPlan[] = [];
  for (const did of issuerDidsInOrder(bundle)) {
    const iss = issuerByDid(did);
    if (!iss) continue;
    const mine = Object.entries(bundle.claims.issuerOf)
      .filter(([, d]) => d === did)
      .map(([claim]) => claim)
      .filter((claim) => claim in claims);
    const decisions = mine.map<ClaimDecision>((claim) => ({
      claim,
      label: claimLabel(bundle, claim),
      value: claims[claim] === true,
      issuerDid: did,
    }));
    plans.push({
      did,
      name: iss.name,
      url: iss.url,
      issuable: decisions.filter((d) => d.value),
      denied: decisions.filter((d) => !d.value),
    });
  }
  return plans;
}

/**
 * 창구가 직접 확인하는 항목 (issuerOf === 'self'). 어떤 발급 요청·동의 화면·증명서 카드에도 들어가지 않으며,
 * 지갑은 시민 본인의 값으로 사전 판정에만 쓴다 (예: 신용평점 하위 20% — 은행이 자체 조회).
 */
export function selfCheckedClaims(bundle: Bundle, claims: ClaimMap): ClaimDecision[] {
  return Object.entries(bundle.claims.issuerOf)
    .filter(([claim, did]) => did === SELF_ISSUER && claim in claims)
    .map(([claim]) => ({ claim, label: claimLabel(bundle, claim), value: claims[claim] === true, issuerDid: SELF_ISSUER }));
}

/**
 * 규칙 해시 대조 결과.
 *  - ledger: 공동원장(RuleRegistry) 등록값과 일치 — 가장 강한 확인
 *  - declared: 원장을 읽지 못해 발급기관이 알린 값과만 일치
 *  - mismatch: 원장 또는 발급기관 값과 다름 (변조 의심 — 발급 중단)
 *  - unregistered: 원장은 응답했지만 이 규칙 버전이 등록되어 있지 않음
 *  - unverified: 원장도 발급기관도 확인하지 못함 (변조가 아니라 '확인 불가' — 중립 표시, F31)
 */
export type HashStatus = 'ledger' | 'declared' | 'mismatch' | 'unregistered' | 'unverified';

export interface HashCheck {
  local: string;
  declared: string | null;
  ledger: string | null;
  status: HashStatus;
  ok: boolean;
}

/**
 * 지갑이 받은 번들을 직접 해시해 공동원장 등록값(onLedger)과 발급기관이 알린 해시(declared)와 대조한다 (불변 조건 4, F19).
 * onLedger 가 undefined 면 원장을 읽지 못한 것이다.
 */
export function checkBundleHash(bundle: Bundle, declared: string | null | undefined, onLedger?: LedgerBundle): HashCheck {
  const local = bundleHash(bundle);
  const d = declared ?? null;
  const ledger = onLedger && onLedger.registered ? onLedger.bundleHash : null;
  const same = (h: string) => h.toLowerCase() === local.toLowerCase();
  let status: HashStatus;
  if ((ledger !== null && !same(ledger)) || (d !== null && !same(d))) status = 'mismatch';
  else if (onLedger && !onLedger.registered) status = 'unregistered';
  else if (ledger !== null) status = 'ledger';
  else if (d !== null) status = 'declared';
  else status = 'unverified';
  return { local, declared: d, ledger, status, ok: status === 'ledger' || status === 'declared' };
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
export function buildRecommendPayload(bundle: Bundle, profile: CitizenProfile, evalDate: string = EVAL_DATE): RecommendPayload {
  const claims = computeClaims(bundle, profile, evalDate);
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

/**
 * 제출 동의 화면의 항목 이름 (F41). 검증기관이 보낸 label 이 아니라 지갑이 아는 이름(규칙 번들 라벨 → 저장된 증명서 라벨 → claim id)을 쓴다.
 * 검증기관 label 이 지갑 이름과 다르면 mismatch 에 그 label 을 담아 경고한다 — 동의하는 사실은 claim 기준이기 때문.
 */
export function consentLabel(
  req: RequestedClaim,
  bundleLabels: Readonly<Record<string, string>>,
  credential?: Pick<StoredCredential, 'label'>,
): { label: string; mismatch: string | null } {
  const known = bundleLabels[req.claim] ?? credential?.label;
  const label = known ?? req.claim;
  const sent = typeof req.label === 'string' ? req.label.trim() : '';
  return { label, mismatch: sent && known !== undefined && sent !== known ? sent : null };
}

// ---------- 증명서 상태 (만료·폐기) ----------

/** VC 의 상태 목록 위치 (credentialStatus). 해석하지 못하면 null. */
export function statusRefOf(vcJwt: string): { listId: string; index: number } | null {
  try {
    const st = decodeVc(vcJwt).vc.credentialStatus as { statusListCredential?: unknown; statusListIndex?: unknown } | undefined;
    const listId = st?.statusListCredential;
    const index = Number(st?.statusListIndex);
    if (typeof listId !== 'string' || !listId || !Number.isSafeInteger(index) || index < 0) return null;
    return { listId, index };
  } catch {
    return null;
  }
}

/**
 * 증명서 카드 상태 (F30). revoked: 원장 상태 목록에서 읽은 폐기 비트 — undefined 는 아직 확인 중, null 은 원장 확인 불가.
 * 폐기가 확인되면 폐기, 그다음 유효기간 만료, 원장에서 폐기되지 않았음이 확인되어야 '유효'.
 */
export type CredentialStatus = 'checking' | 'valid' | 'revoked' | 'expired' | 'unknown';

export function credentialStatusOf(credential: Pick<StoredCredential, 'validUntil'>, now: Date, revoked: boolean | null | undefined): CredentialStatus {
  if (revoked === true) return 'revoked';
  const until = Date.parse(credential.validUntil);
  if (!Number.isNaN(until) && until < now.getTime()) return 'expired';
  if (revoked === false) return 'valid';
  return revoked === undefined ? 'checking' : 'unknown';
}

// ---------- 정책 카드 보조 ----------

/** 조합 안에서 로컬 판정과 어긋나는 항목 (expected=false 는 '해당 없음' 이어야 맞다). */
function unmetClaims(set: readonly RequiredClaim[], claims: ClaimMap): RequiredClaim[] {
  return set.filter((rc) => (claims[rc.claim] === true) !== rc.expected);
}

/**
 * 이 시민에게 맞는 증명 조합 하나 (정책 문서의 requiredClaimSets 는 선호 순).
 * 로컬 판정으로 충족되는 첫 조합(= 적격이면 반드시 있다), 없거나 claims 를 모르면 첫 조합.
 * 옛 형식(requiredClaims)은 claimSetsOf 가 조합 하나로 읽는다.
 */
export function chooseClaimSet(policy: PolicyMeta, claims?: ClaimMap): RequiredClaim[] {
  const sets = claimSetsOf(policy);
  const satisfied = claims ? sets.find((set) => unmetClaims(set, claims).length === 0) : undefined;
  return satisfied ?? sets[0] ?? [];
}

export interface Holding {
  claim: string;
  expected: boolean;
  label: string;
  held: boolean;
  note?: string;
}

/**
 * 이 시민에게 맞는 증명 조합(chooseClaimSet) 대비 보유 증명서. expected=false 항목은 증명서가 존재할 수 없으므로
 * (발급기관은 참인 사실만 발급) 로컬 판정이 거짓이고 참 증명서가 없으면 "해당 없음 확인" 으로 표시한다.
 * issuerOf 가 'self' 인 항목은 증명서가 아니므로 목록에서 뺀다 (창구가 직접 확인).
 */
export function credentialHoldings(
  policy: PolicyMeta,
  credentials: readonly StoredCredential[],
  claims: ClaimMap,
  bundle: Bundle,
): Holding[] {
  return chooseClaimSet(policy, claims).filter((rc) => !isSelfChecked(bundle, rc.claim)).map((rc) => {
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

/**
 * 부적격 정책에서 충족되지 않은 claim 라벨. 증명 조합 중 못 미친 항목이 가장 적은 것(같으면 앞선 것) 기준,
 * 조합이 없으면 규칙 변수.
 */
export function failingClaimLabels(bundle: Bundle, policy: PolicyMeta | undefined, policyId: string, claims: ClaimMap): string[] {
  const sets = policy ? claimSetsOf(policy) : [];
  if (sets.length > 0) {
    const unmet = sets.map((set) => unmetClaims(set, claims));
    const fewest = Math.min(...unmet.map((u) => u.length));
    const fmt = (rc: RequiredClaim) => (rc.expected ? claimLabel(bundle, rc.claim) : `${claimLabel(bundle, rc.claim)} (해당되어야 함: 아니오)`);
    if (fewest > 0) {
      // 못 미친 항목 수가 같은 경로가 여럿이면 하나만 사유처럼 보이지 않게 '또는'으로 함께 보여 준다
      const tied = unmet.filter((u) => u.length === fewest);
      return tied.length === 1 ? tied[0]!.map(fmt) : [tied.map((u) => u.map(fmt).join(' · ')).join(' 또는 ')];
    }
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
    explanation: `${policy.summary} 규칙 엔진이 확인한 결과, 이 제도의 규칙 기준(소득·자격)을 충족합니다.${clause ? ` 근거는 ${clause.title}입니다.` : ''}`,
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
  limit = Number.POSITIVE_INFINITY,
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

/** AI 항목이 있으면 그것을, 없으면 템플릿 카드를 쓴다 (정책 하나 = 카드 하나). */
export function pickRecommendation(policy: PolicyMeta, recs: readonly Recommendation[]): Recommendation {
  return recs.find((r) => r.policyId === policy.policyId) ?? templateRecommendation(policy);
}

// ---------- 창구 종류별 분류 ----------

export type PolicyChannel = 'welfare' | 'finance' | 'discount' | 'transport';

const CHANNELS: readonly PolicyChannel[] = ['welfare', 'finance', 'discount', 'transport'];

/** 예전 캐시(channel 없는 정책 문서)를 위한 예비: category 로 추정한다. */
const CHANNEL_BY_CATEGORY: Record<string, PolicyChannel> = { 금융: 'finance', 생활: 'discount', 교통: 'transport' };

export function policyChannel(policy: PolicyMeta): PolicyChannel {
  const c = policy.channel as PolicyChannel | undefined;
  if (c && CHANNELS.includes(c)) return c;
  return CHANNEL_BY_CATEGORY[policy.category] ?? 'welfare';
}

/** 은행·민간 창구(복지멤버십이 다루지 않는 서민금융·민간 감면) 인지. */
export function isCounterChannel(policy: PolicyMeta): boolean {
  const c = policyChannel(policy);
  return c === 'finance' || c === 'discount';
}

const COUNTER_RANK: Record<PolicyChannel, number> = { finance: 0, discount: 1, welfare: 2, transport: 3 };

function byChannelThenName(a: PolicyMeta, b: PolicyMeta): number {
  return COUNTER_RANK[policyChannel(a)] - COUNTER_RANK[policyChannel(b)] || a.name.localeCompare(b.name, 'ko');
}

export interface EligibleGroups {
  /** A. 은행·민간 창구 혜택 (finance → discount → 이름순). 혜택패스가 증명서 제출로 돕는 대상. */
  counter: PolicyMeta[];
  /** B. 공공 복지·교통 (복지멤버십 안내 대상). 추천이 아니라 판정 결과만 보여준다. */
  welfare: PolicyMeta[];
}

/** 규칙 엔진이 적격으로 판정한 정책을 창구 종류별로 나눈다. 판정은 eligibleIds(규칙 엔진) 가 전부 정한다. */
export function groupEligibleByChannel(index: Record<string, PolicyMeta>, eligibleIds: ReadonlySet<string>): EligibleGroups {
  const eligible = [...eligibleIds]
    .map((id) => index[id])
    .filter((p): p is PolicyMeta => p !== undefined)
    .sort(byChannelThenName);
  return {
    counter: eligible.filter(isCounterChannel),
    welfare: eligible.filter((p) => !isCounterChannel(p)),
  };
}

export interface SubmitDocument {
  claim: string;
  label: string;
  issuerDid: string;
  issuerName: string;
}

/**
 * 창구에 제출할 증명서 = 이 시민에게 맞는 증명 조합(chooseClaimSet) 중 expected=true 이고 발급기관이 있는 것.
 * 'self' 항목(창구 자체 조회 — counterChecks)과 expected=false 항목(증명서 불필요)은 제외한다.
 * 예: 신용 하위 20%·연소득 4,500만 원인 시민의 햇살론 일반보증 → 연소득 4,500만 원 이하 (3,500만 아님).
 */
export function submitDocuments(bundle: Bundle, policy: PolicyMeta, claims?: ClaimMap): SubmitDocument[] {
  return chooseClaimSet(policy, claims)
    .filter((rc) => rc.expected && !isSelfChecked(bundle, rc.claim))
    .map((rc) => {
      const issuerDid = bundle.claims.issuerOf[rc.claim] ?? '';
      return { claim: rc.claim, label: claimLabel(bundle, rc.claim), issuerDid, issuerName: issuerName(issuerDid) };
    });
}

export interface CounterCheck {
  claim: string;
  expected: boolean;
  /** 번들 라벨에서 '(창구 자체 조회)' 꼬리를 뗀 것 — 화면에서 "창구가 직접 확인" 머리말과 겹치지 않게. */
  label: string;
}

/**
 * 같은 증명 조합 중 증명서가 아니라 창구가 직접 확인하는 항목 (issuerOf === 'self', 예: 신용평점 하위 20%).
 * 지갑은 제출하지 않는다 — 창구가 자체 조회한 값이 이 조건을 만족해야 이 조합으로 대상이 된다.
 */
export function counterChecks(bundle: Bundle, policy: PolicyMeta, claims?: ClaimMap): CounterCheck[] {
  return chooseClaimSet(policy, claims)
    .filter((rc) => isSelfChecked(bundle, rc.claim))
    .map((rc) => ({ claim: rc.claim, expected: rc.expected, label: claimLabel(bundle, rc.claim).replace(/\s*\(창구 자체 조회\)$/, '') }));
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
