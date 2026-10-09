/** 검증 서비스(services/verifier) 응답 형태. app.py / verify.py 와 1:1 로 맞춘다. */

export type VerifierProfile = { id: string; did: string; name: string; kind: string };

export type ClaimDef = { claim: string; label: string };

export type RequestedClaim = { claim: string; expected: boolean; label?: string };

/** GET /presets 항목. 창구 용도별로 목적·요청 항목·(선택) 정책 판정을 한 번에 채운다. */
export type Preset = {
  id: string;
  label: string;
  purpose: string;
  requested: { claim: string; expected: boolean }[];
  /** 정책 판정 ID. 서버는 판정이 없는 프리셋에 null 을 보낸다. */
  policyId?: string | null;
  hint: string;
  /** 이 상품을 취급하는 창구 종류(VerifierProfile.kind). 없으면 모든 창구에 보인다. */
  verifierKinds?: string[];
  /** 증명서로 받지 않고 창구가 먼저 자체 조회한 항목(신용평점). 서버가 정책 판정 재현에 창구 확인값으로 넣는다. */
  counterChecked?: { claim: string; expected: boolean }[];
};

export type PresentationRequest = {
  type: "dbp-presentation-request";
  requestId: string;
  shortCode: string;
  verifier: string;
  verifierName: string;
  purpose: string;
  requested: RequestedClaim[];
  nonce: string;
  exp: number; // unix seconds
  responseUri: string;
  qrText: string;
  /**
   * 창구 토큰 — POST /requests 응답에만 있다(QR·qrText·GET /requests 에는 없음). GET /results 에 X-Counter-Token 으로 보내야
   * 결과를 볼 수 있다 (F03). 이전 버전 서버에는 없을 수 있다.
   */
  counterToken?: string;
};

export type Verdict = "PASS" | "FAIL";

/** 검증 단계 11개 (verify.py out.checks). 발급기관 활성·증명서 유효기간·발급 권한까지 화면에 따로 보인다 (F32). */
export const CHECK_KEYS = [
  "nonce",
  "vpSignature",
  "issuerOnLedger",
  "issuerActive",
  "issuerAuthoritative",
  "vcSignature",
  "notExpired",
  "notRevoked",
  "ruleVersion",
  "holderBinding",
  "requestedClaims",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];
export type Checks = Partial<Record<CheckKey, boolean>>;

export const TIMING_PARTS = ["parse", "nonce", "vpSignature", "credentials", "claims"] as const;
export type TimingPart = (typeof TIMING_PARTS)[number];
export type TimingsMs = Partial<Record<TimingPart, number>> & { total: number };

export type CredentialInfo = {
  jti?: string | null;
  issuerDid?: string;
  issuerName?: string | null;
  claim?: string | null;
  value?: boolean | null;
  statusListIndex?: number | string | null;
  statusListVersion?: number;
  ruleVersion?: string;
  checks?: Record<string, boolean>;
  error?: string;
};

export type Receipt = {
  hash: string;
  txHash: string | null;
  object: Record<string, unknown>;
  error?: string;
};

/**
 * policyId 를 보낸 요청에만 포함. 제출된 항목 + 창구 자체 확인 항목(counterChecked)만으로 계산한다.
 * eligible=null 은 판정 불가 — 결과가 제출되지 않은 항목(pending)에 달려 있다. 서버는 미제출 항목을 거짓으로 채우지 않는다.
 * pending·counterChecked 는 이전 버전 서버 응답에는 없을 수 있다.
 */
export type PolicyCheck = {
  policyId: string;
  eligible: boolean | null;
  /** counterCheck: 시민이 제출할 수 없고 창구가 조회하는 항목(issuerOf self) */
  pending?: { claim: string; label: string; counterCheck?: boolean }[];
  counterChecked?: { claim: string; expected: boolean; label: string }[];
};

export type VerificationResult = {
  requestId: string;
  verdict: Verdict;
  reasonCodes: string[];
  reasons: string[];
  verifier: { did: string; name: string; kind: string };
  purpose: string;
  requested: RequestedClaim[];
  claims: Record<string, boolean>;
  issuers: Record<string, string>;
  credentials: CredentialInfo[];
  checks: Checks;
  timingsMs: TimingsMs;
  /** 제출 지갑 DID 앞부분. 서버가 빼면 화면은 "—" 로 둔다. */
  holderDidShort?: string;
  receipt: Receipt;
  verifiedAt: number;
  /** sha256(vpJwt) 앞 8자리(16진) → 10진 % 10000, 4자리. 지갑도 같은 값을 계산해 보여 준다 (F39). */
  confirmCode?: string;
  /** 같은 요청에 따로 기록된 다른 제출 시도 수(재사용·거부된 제출, F08). */
  otherAttempts?: number;
  /** PASS 일 때만 온다 — FAIL 이면 서버가 policyCheck 를 넣지 않는다 (F09). */
  policyCheck?: PolicyCheck;
  comparison?: Comparison;
};

/** 조회형(공공 마이데이터) 대비 보유형(혜택패스) 비교 — 검증 서비스가 data/comparison.json 으로 계산해 준다. 화면은 숫자를 만들지 않는다. */
export type ComparisonDocument = { id: string; name: string; issuer: string; fields: string[]; source: string };
export type Comparison = {
  presetId: string | null;
  pullDocuments: ComparisonDocument[];
  pullItems: string[];
  pullCount: number;
  holdItems: string[];
  holdCount: number;
  reductionPercent: number;
  summary: string;
  pullRecords: string;
  holdRecords: string;
  honestyNote: string;
};

/** exp 는 창구 토큰으로 조회했을 때만 온다(제출 해시로 조회한 지갑에는 없음). */
export type PendingResult = { status: "pending"; requestId: string; exp?: number };
export type DoneResult = VerificationResult & { status: "done" };
export type ResultResponse = PendingResult | DoneResult;

export type Health = { ok: boolean; ledgerConnected: boolean };

/** POST /demo/attack 응답: 저장된 결과 + 결과 키. */
export type AttackResult = VerificationResult & { resultId?: string };

export const ATTACK_KINDS = ["replay", "expired", "forged", "wrong-holder"] as const;
export type AttackKind = (typeof ATTACK_KINDS)[number];
