import { describe, expect, it } from 'vitest';
import { VcError, createVp, decodeJws, generateHolderKey, issueVc, signJws, verifyVc, verifyVp } from '../src/index.js';
import { EVIDENCE, HOLDER_SEED, ISSUER_DID, ISSUER_KID, ISSUER_SEED, LIST_ID, NOW, OTHER_SEED, VERIFIER_DID } from './helpers.js';

const issuer = generateHolderKey(ISSUER_SEED);
const holder = generateHolderKey(HOLDER_SEED);
const other = generateHolderKey(OTHER_SEED);

function vcFor(name: string, index: number): string {
  return issueVc({
    id: `urn:uuid:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    issuerDid: ISSUER_DID,
    issuerKid: ISSUER_KID,
    issuerPrivateKey: issuer.privateKey,
    holderDid: holder.did,
    claim: { name, value: true },
    validFrom: '2026-09-14T00:00:00Z',
    validUntil: '2027-09-14T00:00:00Z',
    status: { listId: LIST_ID, index },
    evidence: EVIDENCE,
  });
}

const vcJwts = [vcFor('daeguResident', 1), vcFor('incomeBelow50Median', 2)];
const nonce = 'n_0123456789abcdef0123456789abcdef';

function vp(overrides: Partial<Parameters<typeof createVp>[0]> = {}): string {
  return createVp({ holderDid: holder.did, holderPrivateKey: holder.privateKey, verifierDid: VERIFIER_DID, nonce, vcJwts, iat: 1789376400, ...overrides });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof VcError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

describe('createVp / verifyVp', () => {
  it('builds the §6.6 payload with the vp+jwt header', () => {
    const jwt = vp();
    const { header, payload } = decodeJws(jwt);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'vp+jwt' });
    expect(payload).toEqual({
      iss: holder.did,
      aud: VERIFIER_DID,
      nonce,
      iat: 1789376400,
      vp: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiablePresentation'],
        verifiableCredential: vcJwts,
      },
    });
  });

  it('verifies, resolves the holder from iss (did:key) and binds VC subjects to the holder', () => {
    const { payload, holderDid } = verifyVp(vp(), { expectedAud: VERIFIER_DID });
    expect(holderDid).toBe(holder.did);
    expect(payload.nonce).toBe(nonce);
    for (const vcJwt of payload.vp.verifiableCredential) {
      const res = verifyVc(vcJwt, issuer.publicKey, { now: NOW });
      expect(res.checks).toEqual({ signature: true, notExpired: true, active: true });
      expect(res.vc.credentialSubject.id).toBe(holderDid);
    }
  });

  it('defaults iat to now (integer seconds)', () => {
    const { payload } = decodeJws(vp({ iat: undefined }));
    expect(Number.isSafeInteger(payload.iat)).toBe(true);
    expect(Math.abs((payload.iat as number) - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('rejects AUD_MISMATCH before anything else', () => {
    expect(codeOf(() => verifyVp(vp(), { expectedAud: 'did:dbp:verifier-other' }))).toBe('AUD_MISMATCH');
  });

  it('rejects a VP signed by someone other than iss (VP_SIG_INVALID)', () => {
    const forged = vp({ holderPrivateKey: other.privateKey });
    expect(codeOf(() => verifyVp(forged, { expectedAud: VERIFIER_DID }))).toBe('VP_SIG_INVALID');
    const tampered = vp().slice(0, -2) + 'AA';
    expect(codeOf(() => verifyVp(tampered, { expectedAud: VERIFIER_DID }))).toBe('VP_SIG_INVALID');
  });

  it('rejects an iss that is not a did:key (VP_SIG_INVALID)', () => {
    const jwt = vp({ holderDid: 'did:dbp:not-a-holder' });
    expect(codeOf(() => verifyVp(jwt, { expectedAud: VERIFIER_DID }))).toBe('VP_SIG_INVALID');
  });

  it('rejects a missing nonce and a wrong typ', () => {
    const noNonce = signJws({
      header: { alg: 'EdDSA', typ: 'vp+jwt' },
      payload: { iss: holder.did, aud: VERIFIER_DID, iat: 1, vp: { verifiableCredential: [] } },
      privateKey: holder.privateKey,
    });
    expect(codeOf(() => verifyVp(noNonce, { expectedAud: VERIFIER_DID }))).toBe('NONCE_MISSING');
    const wrongTyp = signJws({
      header: { alg: 'EdDSA', typ: 'vc+jwt' },
      payload: { iss: holder.did, aud: VERIFIER_DID, nonce, iat: 1, vp: { verifiableCredential: [] } },
      privateKey: holder.privateKey,
    });
    expect(codeOf(() => verifyVp(wrongTyp, { expectedAud: VERIFIER_DID }))).toBe('MALFORMED');
    expect(() => createVp({ holderDid: holder.did, holderPrivateKey: holder.privateKey, verifierDid: VERIFIER_DID, nonce: '', vcJwts })).toThrowError(
      VcError,
    );
  });
});
