/**
 * F67·F68: Python 과 같은 입력만 받는지 — fixtures/strict-inputs.json 을 Python 테스트(test_strict_inputs.py)와 공유한다.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64urlnopad } from '@scure/base';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  VcError,
  b64urlDecode,
  canonicalize,
  decodeJws,
  didKeyToPublicKey,
  ed25519IsValidPublicKey,
  ed25519Verify,
  generateHolderKey,
  signJws,
  verifyJws,
  verifyVp,
} from '../src/index.js';
import { FIXTURES_DIR, HOLDER_SEED } from './helpers.js';

interface Vectors {
  messageUtf8: string;
  ed25519: { name: string; publicKeyHex: string; signatureHex: string; validKey: boolean; verify: boolean }[];
  base64url: { canonical: string; nonCanonical: string[] };
  didKey: { valid: string[]; invalid: string[] };
  jcs: { reject: { json: string; code: string }[]; accept: { json: string; canonical: string }[] };
}

const V = JSON.parse(readFileSync(join(FIXTURES_DIR, 'strict-inputs.json'), 'utf8')) as Vectors;
const MSG = utf8ToBytes(V.messageUtf8);
const VERIFIER_DID = 'did:dbp:verifier:test';
const b64 = (s: string | Uint8Array) => base64urlnopad.encode(typeof s === 'string' ? utf8ToBytes(s) : s);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof VcError ? e.code : 'NOT_VC_ERROR';
  }
  return undefined;
}

describe('ed25519 strict verification (F67)', () => {
  it.each(V.ed25519.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const pk = hexToBytes(c.publicKeyHex);
    expect(ed25519IsValidPublicKey(pk)).toBe(c.validKey);
    expect(ed25519Verify(hexToBytes(c.signatureHex), MSG, pk)).toBe(c.verify);
  });

  it('rejects the identity-key forgery (R=identity, S=0) for any message', () => {
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const forged = new Uint8Array(64);
    forged[0] = 1;
    for (const m of ['', 'dbp', 'any other verifier']) expect(ed25519Verify(forged, utf8ToBytes(m), identity)).toBe(false);
  });

  it('an identity did:key cannot present a VP', () => {
    const header = b64(JSON.stringify({ alg: 'EdDSA', typ: 'vp+jwt' }));
    const payload = b64(
      JSON.stringify({ iss: V.didKey.invalid[0], aud: VERIFIER_DID, nonce: 'n_x', iat: 1789376400, vp: { verifiableCredential: [] } }),
    );
    const sig = new Uint8Array(64);
    sig[0] = 1;
    expect(codeOf(() => verifyVp(`${header}.${payload}.${b64(sig)}`, { expectedAud: VERIFIER_DID }))).toBe('VP_SIG_INVALID');
  });
});

describe('did:key parsing (F67·F68)', () => {
  it.each(V.didKey.valid)('accepts %j', (did) => {
    expect(didKeyToPublicKey(did)).toHaveLength(32);
  });

  it.each(V.didKey.invalid)('rejects %j', (did) => {
    expect(codeOf(() => didKeyToPublicKey(did))).toBe('MALFORMED');
  });

  it('rejects non-string input', () => {
    expect(codeOf(() => didKeyToPublicKey(null as unknown as string))).toBe('MALFORMED');
  });
});

describe('strict base64url (F68)', () => {
  it('accepts only the canonical encoding', () => {
    expect(b64urlDecode(V.base64url.canonical)).toHaveLength(64);
    for (const bad of V.base64url.nonCanonical) expect(() => b64urlDecode(bad)).toThrowError();
    expect(() => b64urlDecode('A')).toThrowError();
  });

  it('rejects JWS signature variants that decode to the same bytes', () => {
    const key = generateHolderKey(HOLDER_SEED);
    const jws = signJws({ header: { alg: 'EdDSA', typ: 'vp+jwt' }, payload: { a: 1 }, privateKey: key.privateKey });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const i = alphabet.indexOf(jws.slice(-1));
    for (let d = 1; d < 16; d++) {
      expect(codeOf(() => verifyJws(jws.slice(0, -1) + alphabet[i + d], key.publicKey))).toBe('MALFORMED');
    }
    expect(verifyJws(jws, key.publicKey).payload).toEqual({ a: 1 });
  });

  it.each([
    ['BOM', new Uint8Array([0xef, 0xbb, 0xbf, ...utf8ToBytes('{"alg":"EdDSA"}')])],
    ['broken UTF-8', new Uint8Array([...utf8ToBytes('{"alg":"EdDSA","x":"'), 0xff, ...utf8ToBytes('"}')])],
    ['NaN', utf8ToBytes('{"alg":"EdDSA","x":NaN}')],
  ])('rejects a JWS segment with %s', (_name, raw) => {
    expect(codeOf(() => decodeJws(`${b64(raw)}.${b64('{}')}.`))).toBe('MALFORMED');
  });
});

describe('JCS input range (F68)', () => {
  it.each(V.jcs.reject.map((c) => [c.json, c] as const))('rejects %s', (_json, c) => {
    expect(codeOf(() => canonicalize(JSON.parse(c.json)))).toBe(c.code);
  });

  it.each(V.jcs.accept.map((c) => [c.json, c] as const))('accepts %s', (_json, c) => {
    expect(canonicalize(JSON.parse(c.json))).toBe(c.canonical);
  });

  it('applies the safe-integer range to bigint too', () => {
    expect(canonicalize([9007199254740991n, -9007199254740991n])).toBe('[9007199254740991,-9007199254740991]');
    for (const bad of [2n ** 53n, -(2n ** 53n), 10n ** 30n]) expect(codeOf(() => canonicalize({ n: bad }))).toBe('FLOAT_FORBIDDEN');
  });

  it('rejects lone surrogates in values and keys', () => {
    expect(codeOf(() => canonicalize({ k: 'a\uD800' }))).toBe('MALFORMED');
    expect(codeOf(() => canonicalize({ ['\uDC00']: 1 }))).toBe('MALFORMED');
    expect(canonicalize({ k: '😀' })).toBe('{"k":"😀"}');
  });
});
