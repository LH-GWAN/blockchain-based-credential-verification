/**
 * 결정론적 크로스언어 픽스처 생성 → packages/vc/fixtures/ts/*.json
 * issuer seed = 0x01×32, holder seed = 0x02×32, 고정 타임스탬프. Python 쪽 scripts/gen_fixtures.py 와 1:1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  bundleHash,
  canonicalize,
  createStatusList,
  createVp,
  decodeVc,
  ed25519PublicKeyHex,
  encodeStatusList,
  generateHolderKey,
  isoToSeconds,
  issueVc,
  setStatus,
  sha256Hex,
} from '../src/index.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'ts');

const issuer = generateHolderKey(new Uint8Array(32).fill(0x01)); // did:dbp 발급기관의 Ed25519 키로 사용
const holder = generateHolderKey(new Uint8Array(32).fill(0x02));

const ISSUER_DID = 'did:dbp:daegu';
const ISSUER_KID = 'did:dbp:daegu#key-1';
const VERIFIER_DID = 'did:dbp:verifier-imbank-branch-01';
const VALID_FROM = '2026-09-14T00:00:00Z';
const VALID_UNTIL = '2027-09-14T00:00:00Z';
const VP_IAT = isoToSeconds('2026-09-14T09:00:00Z');
const NONCE = 'n_fixture00000000000000000000001';
const LIST_ID = 'dbp:status:daegu:list-1';

// jcs.json — 한글, 이스케이프, 제어문자, 중첩, 키 정렬을 모두 포함
const jcsObj = {
  z: [1, true, null, 'x'],
  a: { nested: 'quote"and\\slash\nnewline\ttab', ctrl: '\u0001\u001f\u007f', '가': '대구광역시' },
  B: -0,
  '0': 9007199254740991,
  _: { '': [], empty: {} },
  bundle: 'daegu-eligibility',
  version: '2026.1',
  rule: {
    incomeBelow50Median: {
      '<=': [{ '*': [{ var: 'monthlyIncomeKRW' }, 100] }, { '*': [{ var: 'medianIncomeKRW' }, 50] }],
    },
  },
};
const canonical = canonicalize(jcsObj);
const BUNDLE_HASH = bundleHash(jcsObj);

const vc1 = issueVc({
  id: 'urn:uuid:00000000-0000-4000-8000-000000000001',
  issuerDid: ISSUER_DID,
  issuerKid: ISSUER_KID,
  issuerPrivateKey: issuer.privateKey,
  holderDid: holder.did,
  claim: { name: 'incomeBelow50Median', value: true },
  validFrom: VALID_FROM,
  validUntil: VALID_UNTIL,
  status: { listId: LIST_ID, index: 1042 },
  evidence: { bundle: 'daegu-eligibility', version: '2026.1', bundleHash: BUNDLE_HASH },
});
const vc2 = issueVc({
  id: 'urn:uuid:00000000-0000-4000-8000-000000000002',
  issuerDid: ISSUER_DID,
  issuerKid: ISSUER_KID,
  issuerPrivateKey: issuer.privateKey,
  holderDid: holder.did,
  claim: { name: 'daeguResident', value: true },
  validFrom: VALID_FROM,
  validUntil: VALID_UNTIL,
  status: { listId: LIST_ID, index: 7 },
  evidence: { bundle: 'daegu-eligibility', version: '2026.1', bundleHash: BUNDLE_HASH },
});

const vp = createVp({
  holderDid: holder.did,
  holderPrivateKey: holder.privateKey,
  verifierDid: VERIFIER_DID,
  nonce: NONCE,
  vcJwts: [vc1, vc2],
  iat: VP_IAT,
});

const revokedIndices = [0, 7, 8, 1042, 65535, 131071];
const list = createStatusList();
for (const i of revokedIndices) setStatus(list, i, true);

const files: Record<string, unknown> = {
  'didkey.json': { publicKeyHex: bytesToHex(holder.publicKey), did: holder.did },
  'jcs.json': { obj: jcsObj, canonical, hash: BUNDLE_HASH, sha256: sha256Hex(canonical) },
  'vc.json': {
    jwt: vc1,
    issuerDid: ISSUER_DID,
    issuerPublicKeyHex: ed25519PublicKeyHex(issuer.privateKey),
    holderDid: holder.did,
    payload: decodeVc(vc1).payload,
  },
  'vp.json': { jwt: vp, verifierDid: VERIFIER_DID, nonce: NONCE, vcJwts: [vc1, vc2], holderDid: holder.did, iat: VP_IAT },
  'statuslist.json': { size: list.length * 8, revokedIndices, encoded: encodeStatusList(list) },
};

mkdirSync(OUT, { recursive: true });
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', join(OUT, name));
}
