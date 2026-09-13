import { describe, expect, it } from 'vitest';
import { base64urlnopad } from '@scure/base';
import { VcError, decodeVc, generateHolderKey, issueVc, verifyVc, type IssueVcParams } from '../src/index.js';
import { EVIDENCE, HOLDER_SEED, ISSUER_DID, ISSUER_KID, ISSUER_SEED, LIST_ID, NOW, OTHER_SEED } from './helpers.js';

const issuer = generateHolderKey(ISSUER_SEED);
const holder = generateHolderKey(HOLDER_SEED);
const other = generateHolderKey(OTHER_SEED);

const params: IssueVcParams = {
  id: 'urn:uuid:11111111-1111-4111-8111-111111111111',
  issuerDid: ISSUER_DID,
  issuerKid: ISSUER_KID,
  issuerPrivateKey: issuer.privateKey,
  holderDid: holder.did,
  claim: { name: 'incomeBelow50Median', value: true },
  validFrom: '2026-09-14T00:00:00Z',
  validUntil: '2027-09-14T00:00:00Z',
  status: { listId: LIST_ID, index: 1042 },
  evidence: EVIDENCE,
};

describe('issueVc', () => {
  it('produces the §6.5 payload plus registered JWT claims, with the vc+jwt header', () => {
    const jwt = issueVc(params);
    const { header, payload, vc } = decodeVc(jwt);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'vc+jwt', kid: ISSUER_KID });
    expect(payload).toEqual({
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: params.id,
      type: ['VerifiableCredential', 'DaeguEligibilityCredential'],
      issuer: ISSUER_DID,
      validFrom: '2026-09-14T00:00:00Z',
      validUntil: '2027-09-14T00:00:00Z',
      credentialSubject: { id: holder.did, incomeBelow50Median: true },
      credentialSchema: { id: 'dbp:schema:atomic-claim:1', type: 'JsonSchema' },
      credentialStatus: {
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex: '1042',
        statusListCredential: LIST_ID,
      },
      evidence: [{ type: 'RuleEvaluation', ...EVIDENCE }],
      iss: ISSUER_DID,
      sub: holder.did,
      nbf: 1789344000,
      exp: 1820880000,
      jti: params.id,
    });
    expect(Object.keys(vc)).not.toContain('iss');
    expect(Object.keys(vc)).not.toContain('exp');
    expect(Object.keys(payload).slice(-5)).toEqual(['iss', 'sub', 'nbf', 'exp', 'jti']);
  });

  it('only ever carries one boolean fact and the holder DID in credentialSubject', () => {
    const { vc } = decodeVc(issueVc(params));
    expect(Object.keys(vc.credentialSubject).sort()).toEqual(['id', 'incomeBelow50Median']);
    expect(JSON.stringify(vc)).not.toMatch(/\d{6}-\d{7}/);
  });

  it('is deterministic', () => {
    expect(issueVc(params)).toBe(issueVc(params));
  });

  it('rejects invalid inputs', () => {
    const bad = (patch: Partial<IssueVcParams>) => () => issueVc({ ...params, ...patch });
    expect(bad({ claim: { name: 'x', value: 'true' as unknown as boolean } })).toThrowError(VcError);
    expect(bad({ claim: { name: 'id', value: true } })).toThrowError(VcError);
    expect(bad({ status: { listId: LIST_ID, index: 1.5 } })).toThrowError(VcError);
    expect(bad({ status: { listId: LIST_ID, index: -1 } })).toThrowError(VcError);
    expect(bad({ validFrom: '2026-09-14T00:00:00' })).toThrowError(/timezone/);
    expect(bad({ validFrom: '2026-09-14' })).toThrowError(VcError);
    expect(bad({ validUntil: '2026-09-14T00:00:00Z' })).toThrowError(/after/);
  });
});

describe('verifyVc', () => {
  it('passes all checks inside the validity window with the issuer key', () => {
    const jwt = issueVc(params);
    const res = verifyVc(jwt, issuer.publicKey, { now: NOW });
    expect(res.checks).toEqual({ signature: true, notExpired: true, active: true });
    expect(res.vc.credentialSubject.id).toBe(holder.did);
    expect(res.payload.jti).toBe(params.id);
  });

  it('flags EXPIRED / NOT_YET_VALID via time checks', () => {
    const jwt = issueVc(params);
    expect(verifyVc(jwt, issuer.publicKey, { now: new Date('2027-09-14T00:00:00Z') }).checks).toEqual({
      signature: true,
      notExpired: false,
      active: true,
    });
    expect(verifyVc(jwt, issuer.publicKey, { now: new Date('2026-09-13T23:59:59Z') }).checks).toEqual({
      signature: true,
      notExpired: true,
      active: false,
    });
    expect(verifyVc(jwt, issuer.publicKey, { now: new Date('2026-09-14T00:00:00Z') }).checks.active).toBe(true);
  });

  it('flags a wrong issuer key or a tampered claim as signature=false', () => {
    const jwt = issueVc(params);
    expect(verifyVc(jwt, other.publicKey, { now: NOW }).checks.signature).toBe(false);

    const [h, p, s] = jwt.split('.') as [string, string, string];
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(p)));
    payload.credentialSubject.incomeBelow50Median = false;
    const forged = `${h}.${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))}.${s}`;
    const res = verifyVc(forged, issuer.publicKey, { now: NOW });
    expect(res.checks.signature).toBe(false);
    expect(res.checks.notExpired).toBe(true);
  });

  it('requires typ=vc+jwt for signature=true', () => {
    const jwt = issueVc(params);
    const [, p, s] = jwt.split('.') as [string, string, string];
    const h = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ alg: 'EdDSA', typ: 'vp+jwt' })));
    expect(verifyVc(`${h}.${p}.${s}`, issuer.publicKey, { now: NOW }).checks.signature).toBe(false);
  });

  it('throws MALFORMED on garbage', () => {
    expect(() => verifyVc('garbage', issuer.publicKey)).toThrowError(VcError);
  });
});
