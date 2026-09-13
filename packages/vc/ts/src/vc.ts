import { decodeJws, signJws, verifyJws, type JwsHeader } from './jws.js';
import { dateToSeconds, isoToSeconds } from './time.js';
import { VcError } from './errors.js';

export const VC_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
export const VC_TYPE = ['VerifiableCredential', 'DaeguEligibilityCredential'] as const;
export const VC_SCHEMA = { id: 'dbp:schema:atomic-claim:1', type: 'JsonSchema' } as const;
export const VC_JWT_TYP = 'vc+jwt';

/** §6.5 원자적 자격증명 — credentialSubject에는 holder DID와 불리언 claim 하나만 들어간다. */
export interface AtomicVc {
  '@context': string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: { id: string } & Record<string, boolean | string>;
  credentialSchema: { id: string; type: string };
  credentialStatus: {
    type: 'BitstringStatusListEntry';
    statusPurpose: 'revocation';
    statusListIndex: string;
    statusListCredential: string;
  };
  evidence: Array<{ type: 'RuleEvaluation'; bundle: string; version: string; bundleHash: string }>;
}

/** VC-JWT payload = VC JSON + 등록 JWT 클레임(iss/sub/nbf/exp/jti, 초 단위). */
export interface VcJwtPayload extends AtomicVc {
  iss: string;
  sub: string;
  nbf: number;
  exp: number;
  jti: string;
}

export interface IssueVcParams {
  id: string;
  issuerDid: string;
  issuerKid: string;
  issuerPrivateKey: Uint8Array;
  holderDid: string;
  claim: { name: string; value: boolean };
  validFrom: string;
  validUntil: string;
  status: { listId: string; index: number };
  evidence: { bundle: string; version: string; bundleHash: string };
}

const REGISTERED_CLAIMS = ['iss', 'sub', 'nbf', 'exp', 'jti'] as const;

/** VC-JWT 발급. header `{ alg: 'EdDSA', typ: 'vc+jwt', kid }`. 결정론적(같은 입력 → 같은 JWT). */
export function issueVc(p: IssueVcParams): string {
  if (typeof p.claim?.name !== 'string' || p.claim.name.length === 0 || p.claim.name === 'id') {
    throw new VcError('MALFORMED', 'claim.name must be a non-empty string other than "id"');
  }
  if (typeof p.claim.value !== 'boolean') throw new VcError('MALFORMED', 'claim.value must be boolean (atomic VC)');
  if (!Number.isSafeInteger(p.status?.index) || p.status.index < 0) {
    throw new VcError('MALFORMED', 'status.index must be a non-negative integer');
  }
  const nbf = isoToSeconds(p.validFrom);
  const exp = isoToSeconds(p.validUntil);
  if (exp <= nbf) throw new VcError('MALFORMED', 'validUntil must be after validFrom');

  const payload: VcJwtPayload = {
    '@context': [VC_CONTEXT],
    id: p.id,
    type: [...VC_TYPE],
    issuer: p.issuerDid,
    validFrom: p.validFrom,
    validUntil: p.validUntil,
    credentialSubject: { id: p.holderDid, [p.claim.name]: p.claim.value },
    credentialSchema: { ...VC_SCHEMA },
    credentialStatus: {
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: String(p.status.index),
      statusListCredential: p.status.listId,
    },
    evidence: [{ type: 'RuleEvaluation', bundle: p.evidence.bundle, version: p.evidence.version, bundleHash: p.evidence.bundleHash }],
    iss: p.issuerDid,
    sub: p.holderDid,
    nbf,
    exp,
    jti: p.id,
  };
  const header: JwsHeader = { alg: 'EdDSA', typ: VC_JWT_TYP, kid: p.issuerKid };
  return signJws({ header, payload, privateKey: p.issuerPrivateKey });
}

/** payload에서 등록 JWT 클레임을 뺀 VC JSON. */
function stripRegisteredClaims(payload: VcJwtPayload): AtomicVc {
  const vc: Record<string, unknown> = { ...payload };
  for (const k of REGISTERED_CLAIMS) delete vc[k];
  return vc as unknown as AtomicVc;
}

/** 서명 검증 없이 분해. */
export function decodeVc(jwt: string): { header: JwsHeader; payload: VcJwtPayload; vc: AtomicVc } {
  const { header, payload } = decodeJws<VcJwtPayload>(jwt);
  return { header, payload, vc: stripRegisteredClaims(payload) };
}

export interface VcChecks {
  /** EdDSA 서명이 issuerPublicKey로 검증되고 typ이 vc+jwt인가 (false → VC_SIG_INVALID) */
  signature: boolean;
  /** now < exp (false → EXPIRED) */
  notExpired: boolean;
  /** nbf <= now, 즉 validFrom 도래 (false → NOT_YET_VALID) */
  active: boolean;
}

/**
 * VC-JWT 검증. 서명·만료·유효개시 3가지를 개별 불리언으로 돌려준다 (검증기관이 사유 코드로 매핑).
 * 원장 조회(발급기관 활성, 폐기 비트, 번들 해시)는 호출자(verifier 서비스) 책임이다.
 */
export function verifyVc(
  jwt: string,
  issuerPublicKey: Uint8Array,
  opts: { now?: Date } = {},
): { vc: AtomicVc; payload: VcJwtPayload; checks: VcChecks } {
  const { header, payload, vc } = decodeVc(jwt);
  let signature = false;
  try {
    verifyJws(jwt, issuerPublicKey);
    signature = header.typ === VC_JWT_TYP;
  } catch (e) {
    if (!(e instanceof VcError)) throw e;
    signature = false;
  }
  const now = dateToSeconds(opts.now ?? new Date());
  const notExpired = Number.isSafeInteger(payload.exp) && now < payload.exp;
  const active = Number.isSafeInteger(payload.nbf) && payload.nbf <= now;
  return { vc, payload, checks: { signature, notExpired, active } };
}
