/**
 * 크로스언어 픽스처 검증. 핵심은 Python(dbp_vc)이 만든 fixtures/py/* 를 TS가 검증하는 것이며,
 * 같은 코드로 자체 픽스처(fixtures/ts/*)도 검사한다. 마지막으로 두 언어의 산출물이 바이트 단위로 같은지 본다.
 */
import { describe, expect, it } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
  bundleHash,
  canonicalize,
  decodeStatusList,
  decodeVc,
  didKeyToPublicKey,
  ed25519PublicKeyHex,
  generateHolderKey,
  getStatus,
  publicKeyToDidKey,
  sha256Hex,
  verifyJws,
  verifyVc,
  verifyVp,
} from '../src/index.js';
import { FIXTURES_DIR, HOLDER_SEED, ISSUER_SEED, NOW, hasFixtures, loadFixture, type FixtureLang } from './helpers.js';

const LANGS: FixtureLang[] = ['py', 'ts'];

describe.each(LANGS)('fixtures produced by %s', (lang) => {
  it('exist (run the other language\'s fixture generator first)', () => {
    expect(hasFixtures(lang), `missing ${FIXTURES_DIR}/${lang}/*.json`).toBe(true);
  });

  it('didkey.json: did:key matches the public key both ways', () => {
    const f = loadFixture(lang, 'didkey.json');
    const pk = hexToBytes(f.publicKeyHex);
    expect(publicKeyToDidKey(pk)).toBe(f.did);
    expect(bytesToHex(didKeyToPublicKey(f.did))).toBe(f.publicKeyHex);
    expect(generateHolderKey(HOLDER_SEED).did).toBe(f.did);
  });

  it('jcs.json: canonical string and hash match byte-for-byte', () => {
    const f = loadFixture(lang, 'jcs.json');
    expect(canonicalize(f.obj)).toBe(f.canonical);
    expect(bundleHash(f.obj)).toBe(f.hash);
    expect(sha256Hex(f.canonical)).toBe(f.sha256);
    expect(f.canonical).toContain('대구광역시');
    expect(f.canonical).toContain('\\u0001');
  });

  it('vc.json: signature verifies with the issuer key and payload matches', () => {
    const f = loadFixture(lang, 'vc.json');
    const pk = hexToBytes(f.issuerPublicKeyHex.slice(2));
    expect(f.issuerPublicKeyHex).toBe(ed25519PublicKeyHex(ISSUER_SEED));
    const res = verifyVc(f.jwt, pk, { now: NOW });
    expect(res.checks).toEqual({ signature: true, notExpired: true, active: true });
    expect(res.payload).toEqual(f.payload);
    expect(decodeVc(f.jwt).header).toEqual({ alg: 'EdDSA', typ: 'vc+jwt', kid: `${f.issuerDid}#key-1` });
    expect(res.vc.credentialSubject.id).toBe(f.holderDid);
    expect(res.vc.issuer).toBe(f.issuerDid);
    expect(res.vc.credentialStatus.statusListIndex).toBe('1042');
    expect(verifyVc(f.jwt, generateHolderKey(HOLDER_SEED).publicKey, { now: NOW }).checks.signature).toBe(false);
  });

  it('vp.json: holder signature verifies, aud/nonce match, embedded VCs verify and bind to the holder', () => {
    const f = loadFixture(lang, 'vp.json');
    const vc = loadFixture(lang, 'vc.json');
    const { payload, holderDid } = verifyVp(f.jwt, { expectedAud: f.verifierDid });
    expect(holderDid).toBe(vc.holderDid);
    expect(payload.nonce).toBe(f.nonce);
    expect(payload.vp.verifiableCredential).toEqual(f.vcJwts);
    expect(payload.vp.verifiableCredential[0]).toBe(vc.jwt);
    const issuerPk = hexToBytes(vc.issuerPublicKeyHex.slice(2));
    const names: string[] = [];
    for (const vcJwt of payload.vp.verifiableCredential) {
      const res = verifyVc(vcJwt, issuerPk, { now: NOW });
      expect(res.checks).toEqual({ signature: true, notExpired: true, active: true });
      expect(res.vc.credentialSubject.id).toBe(holderDid);
      names.push(...Object.keys(res.vc.credentialSubject).filter((k) => k !== 'id'));
    }
    expect(names.sort()).toEqual(['daeguResident', 'incomeBelow50Median']);
    expect(() => verifyVp(f.jwt, { expectedAud: 'did:dbp:someone-else' })).toThrowError(/aud/);
    expect(verifyJws(f.jwt, didKeyToPublicKey(holderDid)).header).toEqual({ alg: 'EdDSA', typ: 'vp+jwt' });
  });

  it('statuslist.json: decodes to exactly the revoked indices', () => {
    const f = loadFixture(lang, 'statuslist.json');
    const list = decodeStatusList(f.encoded);
    expect(list.length * 8).toBe(f.size);
    const revoked = new Set<number>(f.revokedIndices);
    for (let i = 0; i < f.size; i++) {
      if (getStatus(list, i) !== revoked.has(i)) throw new Error(`bit ${i} mismatch`);
    }
  });
});

describe('ts and py fixtures agree', () => {
  const both = LANGS.every(hasFixtures);
  it.skipIf(!both)('produce byte-identical JWTs (deterministic Ed25519 + identical serialization)', () => {
    expect(loadFixture('ts', 'vc.json').jwt).toBe(loadFixture('py', 'vc.json').jwt);
    expect(loadFixture('ts', 'vp.json').jwt).toBe(loadFixture('py', 'vp.json').jwt);
    expect(loadFixture('ts', 'vp.json').vcJwts).toEqual(loadFixture('py', 'vp.json').vcJwts);
  });
  it.skipIf(!both)('produce identical canonical strings, hashes, DIDs and revoked sets', () => {
    expect(loadFixture('ts', 'jcs.json').canonical).toBe(loadFixture('py', 'jcs.json').canonical);
    expect(loadFixture('ts', 'jcs.json').hash).toBe(loadFixture('py', 'jcs.json').hash);
    expect(loadFixture('ts', 'didkey.json')).toEqual(loadFixture('py', 'didkey.json'));
    expect(loadFixture('ts', 'statuslist.json').revokedIndices).toEqual(loadFixture('py', 'statuslist.json').revokedIndices);
    // gzip 헤더(OS 바이트 등)는 구현마다 달라 encoded 문자열 자체는 같지 않아도 된다 — 디코딩 결과만 같으면 된다.
    expect(decodeStatusList(loadFixture('ts', 'statuslist.json').encoded)).toEqual(
      decodeStatusList(loadFixture('py', 'statuslist.json').encoded),
    );
  });
});
