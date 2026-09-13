import { didKeyToPublicKey } from './didkey.js';
import { decodeJws, signJws, verifyJws } from './jws.js';
import { dateToSeconds } from './time.js';
import { VC_CONTEXT } from './vc.js';
import { VcError } from './errors.js';

export const VP_JWT_TYP = 'vp+jwt';

/** §6.6 제출(VP) payload. 요청된 claim의 VC만 담는다 (원자적 VC = 선택적 공개). */
export interface VpJwtPayload {
  iss: string;
  aud: string;
  nonce: string;
  iat: number;
  vp: {
    '@context': string[];
    type: string[];
    verifiableCredential: string[];
  };
}

export interface CreateVpParams {
  holderDid: string;
  holderPrivateKey: Uint8Array;
  verifierDid: string;
  nonce: string;
  vcJwts: string[];
  /** epoch seconds. 생략 시 현재 시각 */
  iat?: number;
}

/** VP-JWT 생성. header `{ alg: 'EdDSA', typ: 'vp+jwt' }`. */
export function createVp(p: CreateVpParams): string {
  if (typeof p.nonce !== 'string' || p.nonce.length === 0) throw new VcError('MALFORMED', 'nonce required');
  if (!Array.isArray(p.vcJwts) || p.vcJwts.some((v) => typeof v !== 'string')) {
    throw new VcError('MALFORMED', 'vcJwts must be string[]');
  }
  const iat = p.iat ?? dateToSeconds(new Date());
  if (!Number.isSafeInteger(iat)) throw new VcError('MALFORMED', 'iat must be an integer (seconds)');
  const payload: VpJwtPayload = {
    iss: p.holderDid,
    aud: p.verifierDid,
    nonce: p.nonce,
    iat,
    vp: { '@context': [VC_CONTEXT], type: ['VerifiablePresentation'], verifiableCredential: [...p.vcJwts] },
  };
  return signJws({ header: { alg: 'EdDSA', typ: VP_JWT_TYP }, payload, privateKey: p.holderPrivateKey });
}

/**
 * VP-JWT 검증 (§9 1~3단계): 파싱 → aud 일치 → nonce 존재 → iss(did:key)에서 공개키 복원 → 서명.
 * 실패 시 VcError(code = AUD_MISMATCH | NONCE_MISSING | VP_SIG_INVALID | MALFORMED).
 * nonce 단일 사용 검사는 호출자(verifier 서비스) 책임.
 */
export function verifyVp(jwt: string, opts: { expectedAud: string }): { payload: VpJwtPayload; holderDid: string } {
  const { header, payload } = decodeJws<VpJwtPayload>(jwt);
  if (header.typ !== VP_JWT_TYP) throw new VcError('MALFORMED', `typ must be ${VP_JWT_TYP}`);
  if (payload.aud !== opts.expectedAud) throw new VcError('AUD_MISMATCH', 'VP aud does not match verifier DID');
  if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) throw new VcError('NONCE_MISSING', 'VP nonce missing');
  if (typeof payload.iss !== 'string') throw new VcError('MALFORMED', 'VP iss missing');
  if (!payload.vp || !Array.isArray(payload.vp.verifiableCredential)) throw new VcError('MALFORMED', 'vp.verifiableCredential missing');

  let publicKey: Uint8Array;
  try {
    publicKey = didKeyToPublicKey(payload.iss);
  } catch {
    throw new VcError('VP_SIG_INVALID', `cannot resolve holder key from ${payload.iss}`);
  }
  try {
    verifyJws(jwt, publicKey);
  } catch (e) {
    if (e instanceof VcError) throw new VcError('VP_SIG_INVALID', e.message);
    throw e;
  }
  return { payload, holderDid: payload.iss };
}
