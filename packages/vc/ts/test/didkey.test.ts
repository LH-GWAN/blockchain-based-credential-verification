import { describe, expect, it } from 'vitest';
import { base58 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  VcError,
  didKeyToPublicKey,
  ed25519PublicKey,
  ed25519PublicKeyHex,
  ed25519Sign,
  ed25519Verify,
  generateHolderKey,
  publicKeyToDidKey,
} from '../src/index.js';
import { HOLDER_SEED } from './helpers.js';

// RFC 8032 §7.1 TEST 1
const RFC_SK = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC_PK = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RFC_SIG =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

describe('ed25519', () => {
  it('derives the RFC 8032 public key and signature', () => {
    const sk = hexToBytes(RFC_SK);
    expect(bytesToHex(ed25519PublicKey(sk))).toBe(RFC_PK);
    expect(ed25519PublicKeyHex(sk)).toBe('0x' + RFC_PK);
    const sig = ed25519Sign(new Uint8Array(0), sk);
    expect(bytesToHex(sig)).toBe(RFC_SIG);
    expect(ed25519Verify(sig, new Uint8Array(0), hexToBytes(RFC_PK))).toBe(true);
    expect(ed25519Verify(sig, new Uint8Array([1]), hexToBytes(RFC_PK))).toBe(false);
    expect(ed25519Verify(new Uint8Array(63), new Uint8Array(0), hexToBytes(RFC_PK))).toBe(false);
  });

  it('rejects private keys that are not 32 bytes', () => {
    expect(() => ed25519PublicKey(new Uint8Array(31))).toThrowError(VcError);
    expect(() => ed25519Sign(new Uint8Array(0), new Uint8Array(64))).toThrowError(VcError);
  });
});

describe('did:key', () => {
  it('generates deterministic keys from a seed', () => {
    const a = generateHolderKey(HOLDER_SEED);
    const b = generateHolderKey(HOLDER_SEED);
    expect(a.did).toBe(b.did);
    expect(a.did.startsWith('did:key:z6Mk')).toBe(true);
    expect(a.privateKey).toEqual(HOLDER_SEED);
    expect(a.publicKey.length).toBe(32);
  });

  it('generates random keys without a seed', () => {
    const a = generateHolderKey();
    const b = generateHolderKey();
    expect(a.did).not.toBe(b.did);
    expect(a.privateKey.length).toBe(32);
  });

  it('round-trips public key <-> did:key and tolerates fragments', () => {
    const { publicKey, did } = generateHolderKey(HOLDER_SEED);
    expect(publicKeyToDidKey(publicKey)).toBe(did);
    expect(didKeyToPublicKey(did)).toEqual(publicKey);
    expect(didKeyToPublicKey(did + '#' + did.slice(8))).toEqual(publicKey);
  });

  it('encodes multicodec 0xed01 + key in base58btc', () => {
    const { publicKey, did } = generateHolderKey(HOLDER_SEED);
    const raw = base58.decode(did.slice('did:key:z'.length));
    expect(Array.from(raw.slice(0, 2))).toEqual([0xed, 0x01]);
    expect(raw.slice(2)).toEqual(publicKey);
  });

  it('rejects malformed DIDs', () => {
    expect(() => didKeyToPublicKey('did:dbp:daegu')).toThrowError(VcError);
    expect(() => didKeyToPublicKey('did:key:z0OIl')).toThrowError(VcError);
    const wrongCodec = 'did:key:z' + base58.encode(new Uint8Array([0xec, 0x01, ...new Uint8Array(32)]));
    expect(() => didKeyToPublicKey(wrongCodec)).toThrowError(VcError);
    expect(() => publicKeyToDidKey(new Uint8Array(31))).toThrowError(VcError);
    expect(() => generateHolderKey(new Uint8Array(16))).toThrowError(VcError);
  });
});
