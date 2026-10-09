/** 서비스 주소. NEXT_PUBLIC_* 는 빌드 시 인라인되므로 반드시 리터럴로 참조한다. */
export const ENV = {
  ISSUER_DAEGU_URL: process.env.NEXT_PUBLIC_ISSUER_DAEGU_URL ?? 'http://localhost:8001',
  ISSUER_WELFARE_URL: process.env.NEXT_PUBLIC_ISSUER_WELFARE_URL ?? 'http://localhost:8003',
  VERIFIER_URL: process.env.NEXT_PUBLIC_VERIFIER_URL ?? 'http://localhost:8002',
  AI_URL: process.env.NEXT_PUBLIC_AI_URL ?? 'http://localhost:8004',
  RPC_URL: process.env.NEXT_PUBLIC_RPC_URL ?? 'http://localhost:8545',
  /**
   * 공동원장 컨트랙트 주소 (선택). 빌드 설정에 있으면 발급기관에 배포 정보를 묻지 않는다 (F40).
   * 없으면 발급기관 `/ledger/deployment` 에서 한 번 받아 단말에 저장해 둔다.
   */
  RULE_REGISTRY_ADDRESS: process.env.NEXT_PUBLIC_RULE_REGISTRY_ADDRESS ?? '',
  STATUS_LIST_REGISTRY_ADDRESS: process.env.NEXT_PUBLIC_STATUS_LIST_REGISTRY_ADDRESS ?? '',
  RECEIPT_ANCHOR_ADDRESS: process.env.NEXT_PUBLIC_RECEIPT_ANCHOR_ADDRESS ?? '',
} as const;

export interface IssuerEndpoint {
  did: string;
  name: string;
  url: string;
}

/**
 * 발급기관은 공공기관뿐이다: 대구광역시(주민등록·가구·연령 사실) → 사회보장정보원(수급·소득구간·연소득 사실).
 * 은행은 검증기관(제출처)일 뿐 발급하지 않는다. 동의 화면 순서는 번들 claims.issuerOf 의 출현 순서를 따른다.
 */
export const ISSUERS: readonly IssuerEndpoint[] = [
  { did: 'did:dbp:daegu', name: '대구광역시', url: ENV.ISSUER_DAEGU_URL },
  { did: 'did:dbp:welfare', name: '사회보장정보원(복지기관)', url: ENV.ISSUER_WELFARE_URL },
];

/** 발급기관 DID → 서버 주소. */
export const ISSUER_URL_BY_DID: Readonly<Record<string, string>> = Object.fromEntries(ISSUERS.map((i) => [i.did, i.url]));

/**
 * claims.issuerOf 의 특수값: 이 사실은 증명서로 발급하지 않는다.
 * 지갑은 시민 본인의 값으로 사전 판정에만 쓰고, 창구(은행)가 직접 조회한다 (예: 신용평점 하위 20%).
 */
export const SELF_ISSUER = 'self';

export function issuerByDid(did: string): IssuerEndpoint | undefined {
  return ISSUERS.find((i) => i.did === did);
}

export function issuerName(did: string): string {
  return issuerByDid(did)?.name ?? did;
}

export const BUNDLE = { bundle: 'daegu-eligibility', version: '2026.2' } as const;

/**
 * 규칙 평가 기준일의 기본값 (프롬프트 §15-5: 테스트 결정론).
 * 발급기관이 `/.well-known/issuer` 의 bundle.evalDate 로 알려 주면 그 날짜를 쓴다 (F65 — 발급기관 RULE_EVAL_DATE 와 일치).
 */
export const EVAL_DATE = '2026-09-14';

/** 'YYYY-MM-DD' 형식이고 실제 날짜이면 그 값, 아니면 null. */
export function validEvalDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

export const DEFAULT_CITIZEN_ID = 'C-001';
