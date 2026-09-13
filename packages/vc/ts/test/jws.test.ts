import { describe, expect, it } from 'vitest';
import { base64urlnopad } from '@scure/base';
import { VcError, decodeJws, generateHolderKey, signJws, verifyJws } from '../src/index.js';
import { HOLDER_SEED, OTHER_SEED } from './helpers.js';

const key = generateHolderKey(HOLDER_SEED);
const other = generateHolderKey(OTHER_SEED);
const header = { alg: 'EdDSA' as const, typ: 'vc+jwt', kid: 'did:dbp:daegu#key-1' };
const payload = { a: 1, k: '대구', nested: { ok: true } };

describe('JWS compact (EdDSA)', () => {
  it('produces 3 base64url segments with the given header, deterministically', () => {
    const jws = signJws({ header, payload, privateKey: key.privateKey });
    const parts = jws.split('.');
    expect(parts).toHaveLength(3);
    expect(jws).not.toContain('=');
    expect(JSON.parse(new TextDecoder().decode(base64urlnopad.decode(parts[0]!)))).toEqual(header);
    expect(base64urlnopad.decode(parts[2]!).length).toBe(64);
    expect(signJws({ header, payload, privateKey: key.privateKey })).toBe(jws);
  });

  it('verifies and returns header/payload', () => {
    const jws = signJws({ header, payload, privateKey: key.privateKey });
    const out = verifyJws(jws, key.publicKey);
    expect(out.header).toEqual(header);
    expect(out.payload).toEqual(payload);
    expect(decodeJws(jws).payload).toEqual(payload);
  });

  it('rejects a tampered payload, wrong key and bad signature bytes', () => {
    const jws = signJws({ header, payload, privateKey: key.privateKey });
    const [h, , s] = jws.split('.') as [string, string, string];
    const forged = `${h}.${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ a: 2 })))}.${s}`;
    for (const bad of [forged, jws.slice(0, -2) + 'AA']) {
      expect(() => verifyJws(bad, key.publicKey)).toThrowError(VcError);
      try {
        verifyJws(bad, key.publicKey);
      } catch (e) {
        expect((e as VcError).code).toBe('SIG_INVALID');
      }
    }
    expect(() => verifyJws(jws, other.publicKey)).toThrowError(/signature/);
  });

  it('rejects malformed input and unsupported alg', () => {
    expect(() => verifyJws('a.b', key.publicKey)).toThrowError(VcError);
    expect(() => verifyJws('not.base64url.@@', key.publicKey)).toThrowError(VcError);
    expect(() => decodeJws('x.y.z.w')).toThrowError(/3 segments/);
    expect(() => signJws({ header: { alg: 'HS256' as unknown as 'EdDSA' }, payload, privateKey: key.privateKey })).toThrowError(
      VcError,
    );
    const noneHeader = base64urlnopad.encode(new TextEncoder().encode('{"alg":"none"}'));
    const [, p, s] = signJws({ header, payload, privateKey: key.privateKey }).split('.') as [string, string, string];
    expect(() => verifyJws(`${noneHeader}.${p}.${s}`, key.publicKey)).toThrowError(/alg/);
  });
});
