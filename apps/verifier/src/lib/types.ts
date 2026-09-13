/** 검증 서비스(services/verifier) 응답 형태. app.py / verify.py 와 1:1 로 맞춘다. */

export type VerifierProfile = { id: string; did: string; name: string; kind: string };

export type ClaimDef = { claim: string; label: string };

export type RequestedClaim = { claim: string; expected: boolean; label?: string };

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
  policyCheck?: { policyId: string; eligible: boolean | null };
};

export type PendingResult = { status: "pending"; requestId: string; exp: number };
export type DoneResult = VerificationResult & { status: "done" };
export type ResultResponse = PendingResult | DoneResult;

export type Health = { ok: boolean; ledgerConnected: boolean };

export const ATTACK_KINDS = ["replay", "expired", "forged", "wrong-holder"] as const;
export type AttackKind = (typeof ATTACK_KINDS)[number];
