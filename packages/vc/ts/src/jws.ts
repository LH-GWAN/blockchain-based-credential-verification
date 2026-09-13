import { base64urlnopad } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ed25519Sign, ed25519Verify } from './ed25519.js';
import { VcError } from './errors.js';

export interface JwsHeader {
  alg: 'EdDSA';
  typ?: string;
  kid?: string;
  [k: string]: unknown;
}

export interface DecodedJws<P = Record<string, unknown>> {
  header: JwsHeader;
  payload: P;
  signature: Uint8Array;
  /** `base64url(header).base64url(payload)` — 서명 대상 바이트의 문자열 */
  signingInput: string;
}

const decoder = new TextDecoder();

function encodeJson(obj: unknown): string {
  return base64urlnopad.encode(utf8ToBytes(JSON.stringify(obj)));
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(decoder.decode(base64urlnopad.decode(segment)));
  } catch {
    throw new VcError('MALFORMED', 'JWS segment is not base64url JSON');
  }
}

/** compact JWS 생성 (EdDSA/Ed25519, base64url 패딩 없음). 서명은 결정론적이다. */
export function signJws(params: { header: JwsHeader; payload: unknown; privateKey: Uint8Array }): string {
  if (params.header.alg !== 'EdDSA') throw new VcError('MALFORMED', 'only alg=EdDSA is supported');
  const signingInput = `${encodeJson(params.header)}.${encodeJson(params.payload)}`;
  const signature = ed25519Sign(utf8ToBytes(signingInput), params.privateKey);
  return `${signingInput}.${base64urlnopad.encode(signature)}`;
}

/** 검증 없이 분해만 한다. 구조가 깨지면 MALFORMED. */
export function decodeJws<P = Record<string, unknown>>(jws: string): DecodedJws<P> {
  if (typeof jws !== 'string') throw new VcError('MALFORMED', 'JWS must be a string');
  const parts = jws.split('.');
  if (parts.length !== 3) throw new VcError('MALFORMED', 'compact JWS must have 3 segments');
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new VcError('MALFORMED', 'JWS header must be an object');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new VcError('MALFORMED', 'JWS payload must be an object');
  let signature: Uint8Array;
  try {
    signature = base64urlnopad.decode(s);
  } catch {
    throw new VcError('MALFORMED', 'JWS signature is not base64url');
  }
  return { header: header as JwsHeader, payload: payload as P, signature, signingInput: `${h}.${p}` };
}

/** 서명 검증. 실패 시 SIG_INVALID 예외, 성공 시 header/payload 반환. */
export function verifyJws<P = Record<string, unknown>>(jws: string, publicKey: Uint8Array): { header: JwsHeader; payload: P } {
  const { header, payload, signature, signingInput } = decodeJws<P>(jws);
  if (header.alg !== 'EdDSA') throw new VcError('SIG_INVALID', `unsupported alg: ${String(header.alg)}`);
  if (!ed25519Verify(signature, utf8ToBytes(signingInput), publicKey)) {
    throw new VcError('SIG_INVALID', 'JWS signature verification failed');
  }
  return { header, payload };
}
