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

// Python `.decode("utf-8")` 과 같게: 깨진 UTF-8 은 대체문자로 바꾸지 않고 거부, BOM 은 벗기지 않는다
// (그러면 JSON.parse 가 거부한다 — Python json.loads 도 BOM 을 거부한다).
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * 엄격한 base64url(패딩 없음) 디코딩 (F68). 알파벳 밖 문자, 마지막 글자의 남는 비트가 0이 아닌 변형은
 * 다시 인코딩한 값이 입력과 달라지므로 거부한다. Python `b64url_decode` 와 같은 입력만 받는다.
 */
export function b64urlDecode(text: string): Uint8Array {
  if (typeof text !== 'string' || !B64URL_RE.test(text)) throw new Error('not base64url');
  const bytes = base64urlnopad.decode(text);
  if (base64urlnopad.encode(bytes) !== text) throw new Error('non-canonical base64url');
  return bytes;
}

function encodeJson(obj: unknown): string {
  return base64urlnopad.encode(utf8ToBytes(JSON.stringify(obj)));
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(decoder.decode(b64urlDecode(segment)));
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
    signature = b64urlDecode(s);
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
