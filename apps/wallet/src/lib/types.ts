import type { Bundle, CategoricalProfile, CitizenProfile, ClaimMap, LegalBasis, PolicyMeta, RequiredClaim } from '@dbp/rules';

export type { Bundle, CategoricalProfile, CitizenProfile, ClaimMap, LegalBasis, PolicyMeta, RequiredClaim };

// ---------- 지갑 저장소 (IndexedDB) ----------

/** 홀더 키. privateKey 는 32바이트 시드 hex — 단말 밖으로 절대 나가지 않는다. */
export interface WalletRecord {
  privateKey: string;
  publicKey: string;
  did: string;
  citizenId: string;
  createdAt: string;
}

/** 저장된 자격 증명서. 원본 수치·이름은 없다 (claim 은 불리언 하나). */
export interface StoredCredential {
  jti: string;
  claim: string;
  label: string;
  value: boolean;
  vcJwt: string;
  issuerDid: string;
  issuerName: string;
  statusListIndex: number;
  validUntil: string;
  issuedAt: string;
}

export interface ReceiptData {
  hash: string;
  txHash: string | null;
  object: Record<string, unknown>;
}

/** 동의 영수증 (발급 시). 원문+salt 는 지갑만 보관, 원장에는 해시만. */
export interface ConsentReceiptRecord extends ReceiptData {
  issuerDid: string;
  issuerName: string;
  claims: string[];
  at: string;
}

export interface RequestedClaim {
  claim: string;
  expected: boolean;
  label?: string;
}

/** 제출 영수증 + 결과 (검증 시). */
export interface PresentationRecord {
  requestId: string;
  verifierDid: string;
  verifierName: string;
  purpose: string;
  requested: RequestedClaim[];
  verdict: 'PASS' | 'FAIL';
  reasonCodes: string[];
  reasons: string[];
  receipt: ReceiptData | null;
  totalMs: number | null;
  at: string;
}

// ---------- 발급기관 API ----------

export interface IssuerWellKnown {
  did: string;
  name: string;
  kid: string;
  ed25519PublicKeyHex: string;
  claims: Array<{ claim: string; label: string }>;
  bundle: { bundle: string; version: string; bundleHash: string; schemaHash: string };
  statusListId: string;
  ledgerConnected: boolean;
}

export interface ChallengeResponse {
  nonce: string;
  exp: number;
  aud: string;
}

export interface IssueBody {
  citizenId: string;
  holderDid: string;
  holderProof: string;
  requestedClaims: string[];
  consent: { scope: string[]; ts: string };
}

export interface IssuedCredential {
  jti: string;
  claim: string;
  label: string;
  vcJwt: string;
  statusListIndex: number;
  validUntil: string;
}

export interface DeniedClaim {
  claim: string;
  label: string;
  reason: string;
  ruleRef: { bundle: string; version: string; claim: string };
}

export interface IssueResponse {
  issuer: { did: string; name: string };
  credentials: IssuedCredential[];
  denied: DeniedClaim[];
  consentReceipt: ReceiptData;
  bundle: { bundle: string; version: string; bundleHash: string };
}

export interface LedgerDeployment {
  chainId: number;
  rpcUrl: string;
  contracts: Record<string, { address: string; abi: unknown[] }>;
}

// ---------- 검증기관 API ----------

export interface PresentationRequest {
  type: 'dbp-presentation-request';
  requestId: string;
  shortCode: string;
  verifier: string;
  verifierName: string;
  purpose: string;
  requested: RequestedClaim[];
  nonce: string;
  exp: number;
  responseUri: string;
}

export interface PresentResult {
  requestId: string;
  verdict: 'PASS' | 'FAIL';
  reasonCodes: string[];
  reasons: string[];
  verifier: { did: string; name: string; kind?: string };
  purpose: string;
  requested: RequestedClaim[];
  claims: Record<string, boolean>;
  issuers: Record<string, string>;
  checks: Record<string, boolean>;
  timingsMs: Record<string, number>;
  holderDidShort: string;
  receipt: ReceiptData & { error?: string };
  verifiedAt: number;
  status?: 'done' | 'pending';
}

// ---------- AI API (범주값만) ----------

export interface RuleResult {
  policyId: string;
  eligible: boolean;
  matchedClaims: string[];
}

export interface RecommendPayload {
  categoricalProfile: CategoricalProfile;
  ruleResults: RuleResult[];
  locale: 'ko';
}

export interface Recommendation {
  policyId: string;
  headline: string;
  explanation: string;
  citations: string[];
  nextSteps: string;
  source?: 'llm' | 'template';
}

export type AiProvider = 'anthropic' | 'template';

export interface RecommendResponse {
  recommendations: Recommendation[];
  disclaimer: string;
  provider: AiProvider;
  judgedBy?: string;
}

export interface ChatPayload {
  sessionId: string;
  message: string;
  categoricalProfile: CategoricalProfile;
  ruleResults: RuleResult[];
}

export interface ChatCompleteResponse {
  sessionId: string;
  text: string;
  provider: AiProvider;
}

export interface AuditPayload {
  available: boolean;
  kind: string | null;
  provider: string | null;
  model: string | null;
  recordedAt?: string;
  payload: unknown;
}
