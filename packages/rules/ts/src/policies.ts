/** data/policies/*.json 의 정책 메타데이터 타입과 색인 (로드는 '@dbp/rules/node' 의 loadPolicies). */

export interface LegalBasis {
  clauseId: string;
  title: string;
  text: string;
  sourceUrl: string;
}

export interface RequiredClaim {
  claim: string;
  expected: boolean;
}

export interface PolicyMeta {
  policyId: string;
  name: string;
  category: string;
  agency: string;
  summary: string;
  howToApply: string;
  legalBasis: LegalBasis[];
  basisVerified: boolean;
  /**
   * 정책을 참으로 만드는 증명 조합(anyOf). 각 조합은 RequiredClaim 의 AND 이고,
   * issuerOf 가 'self' 인 항목(신용평점)도 들어 있다 — 그 항목은 창구가 직접 확인한다.
   */
  requiredClaimSets: RequiredClaim[][];
  /** 2026.2 이전 형식(조합 하나). 캐시에 남은 옛 정책 문서를 읽을 때만 쓴다 — claimSetsOf 참고. */
  requiredClaims?: RequiredClaim[];
  ruleRef: { bundle: string; version: string };
  notes?: string;
  /** 제출 창구 종류: 'welfare' | 'finance' | 'discount' | 'transport'. */
  channel?: string;
  /** 복지멤버십(163종)이 이미 안내하는 공공 복지인지. */
  welfareMembership?: boolean;
  /** 창구에 무엇을 제출하는지 한 줄 안내. */
  verifierHint?: string;
}

/** 정책의 증명 조합 (Python `claim_sets`). 옛 형식(requiredClaims)은 조합 하나로 읽는다. */
export function claimSetsOf(policy: Pick<PolicyMeta, 'requiredClaimSets' | 'requiredClaims'>): RequiredClaim[][] {
  if (Array.isArray(policy.requiredClaimSets)) return policy.requiredClaimSets;
  return policy.requiredClaims && policy.requiredClaims.length > 0 ? [policy.requiredClaims] : [];
}

/** policyId → 메타데이터 (Python `policy_index`). */
export function policyIndex(policies: readonly PolicyMeta[]): Record<string, PolicyMeta> {
  return Object.fromEntries(policies.map((p) => [p.policyId, p]));
}
