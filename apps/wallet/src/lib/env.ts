/** 서비스 주소. NEXT_PUBLIC_* 는 빌드 시 인라인되므로 반드시 리터럴로 참조한다. */
export const ENV = {
  ISSUER_DAEGU_URL: process.env.NEXT_PUBLIC_ISSUER_DAEGU_URL ?? 'http://localhost:8001',
  ISSUER_IMBANK_URL: process.env.NEXT_PUBLIC_ISSUER_IMBANK_URL ?? 'http://localhost:8003',
  VERIFIER_URL: process.env.NEXT_PUBLIC_VERIFIER_URL ?? 'http://localhost:8002',
  AI_URL: process.env.NEXT_PUBLIC_AI_URL ?? 'http://localhost:8004',
  RPC_URL: process.env.NEXT_PUBLIC_RPC_URL ?? 'http://localhost:8545',
} as const;

export interface IssuerEndpoint {
  did: string;
  name: string;
  url: string;
}

/** 발급기관 순서 고정: 대구광역시 → iM뱅크 (동의 화면 순서와 동일). */
export const ISSUERS: readonly IssuerEndpoint[] = [
  { did: 'did:dbp:daegu', name: '대구광역시', url: ENV.ISSUER_DAEGU_URL },
  { did: 'did:dbp:imbank', name: 'iM뱅크', url: ENV.ISSUER_IMBANK_URL },
];

export function issuerByDid(did: string): IssuerEndpoint | undefined {
  return ISSUERS.find((i) => i.did === did);
}

export const BUNDLE = { bundle: 'daegu-eligibility', version: '2026.1' } as const;

/** 규칙 평가 기준일 (프롬프트 §15-5: 테스트 결정론). */
export const EVAL_DATE = '2026-09-14';

export const DEFAULT_CITIZEN_ID = 'C-001';
