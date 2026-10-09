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
};

export type Verdict = "PASS" | "FAIL";

export const CHECK_KEYS = [
  "nonce",
  "vpSignature",
  "issuerOnLedger",
  "vcSignature",
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

/** policyId 를 보낸 요청에만 포함. eligible=null 은 규칙 묶음에 없는 정책. */
export type PolicyCheck = { policyId: string; eligible: boolean | null };

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
  holderDidShort: string;
  receipt: Receipt;
  verifiedAt: number;
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

export type PendingResult = { status: "pending"; requestId: string; exp: number };
export type DoneResult = VerificationResult & { status: "done" };
export type ResultResponse = PendingResult | DoneResult;

export type Health = { ok: boolean; ledgerConnected: boolean };

export const ATTACK_KINDS = ["replay", "expired", "forged", "wrong-holder"] as const;
export type AttackKind = (typeof ATTACK_KINDS)[number];
