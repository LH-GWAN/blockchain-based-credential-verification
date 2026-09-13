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
  requiredClaims: RequiredClaim[];
  ruleRef: { bundle: string; version: string };
  notes?: string;
  /** 제출 창구 종류: 'welfare' | 'finance' | 'discount' | 'transport'. */
  channel?: string;
  /** 복지멤버십(163종)이 이미 안내하는 공공 복지인지. */
  welfareMembership?: boolean;
  /** 창구에 무엇을 제출하는지 한 줄 안내. */
  verifierHint?: string;
}

/** policyId → 메타데이터 (Python `policy_index`). */
export function policyIndex(policies: readonly PolicyMeta[]): Record<string, PolicyMeta> {
  return Object.fromEntries(policies.map((p) => [p.policyId, p]));
}
