/** 서비스 주소. NEXT_PUBLIC_* 는 빌드 시 인라인되므로 반드시 리터럴로 참조한다. */
export const ENV = {
  ISSUER_DAEGU_URL: process.env.NEXT_PUBLIC_ISSUER_DAEGU_URL ?? 'http://localhost:8001',
  ISSUER_WELFARE_URL: process.env.NEXT_PUBLIC_ISSUER_WELFARE_URL ?? 'http://localhost:8003',
  VERIFIER_URL: process.env.NEXT_PUBLIC_VERIFIER_URL ?? 'http://localhost:8002',
  AI_URL: process.env.NEXT_PUBLIC_AI_URL ?? 'http://localhost:8004',
  RPC_URL: process.env.NEXT_PUBLIC_RPC_URL ?? 'http://localhost:8545',
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

export const BUNDLE = { bundle: 'daegu-eligibility', version: '2026.1' } as const;

/** 규칙 평가 기준일 (프롬프트 §15-5: 테스트 결정론). */
export const EVAL_DATE = '2026-09-14';

export const DEFAULT_CITIZEN_ID = 'C-001';
