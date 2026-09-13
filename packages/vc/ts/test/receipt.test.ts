import { describe, expect, it } from 'vitest';
import { VcError, bundleHash, randomNonce, randomSalt, receiptHash } from '../src/index.js';

describe('receipts (§6.8)', () => {
  it('hashes JCS(obj) with a 0x prefix, independent of key order', () => {
    const consent = {
      kind: 'consent',
      holderDid: 'did:key:z6MkExample',
      issuerDid: 'did:dbp:daegu',
      claims: ['daeguResident', 'incomeBelow50Median'],
      ts: 1789344000,
      salt: 'ab'.repeat(32),
    };
    const h = receiptHash(consent);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receiptHash({ salt: consent.salt, ts: consent.ts, claims: consent.claims, issuerDid: consent.issuerDid, holderDid: consent.holderDid, kind: 'consent' })).toBe(h);
    expect(receiptHash({ ...consent, salt: 'cd'.repeat(32) })).not.toBe(h);
    expect(h).toBe(bundleHash(consent));
  });

  it('rejects floats in receipts (ts must be integer seconds)', () => {
    expect(() => receiptHash({ kind: 'presentation', ts: 1789344000.5 })).toThrowError(VcError);
  });

  it('generates 32-byte hex salts and n_-prefixed nonces', () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(randomNonce()).toMatch(/^n_[0-9a-f]{32}$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });
});
