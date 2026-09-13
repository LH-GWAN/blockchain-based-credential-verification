import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export type FixtureLang = 'ts' | 'py';

export function hasFixtures(lang: FixtureLang): boolean {
  return existsSync(join(FIXTURES_DIR, lang, 'vc.json'));
}

export function loadFixture<T = Record<string, any>>(lang: FixtureLang, name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, lang, name), 'utf8')) as T;
}

export const ISSUER_SEED = new Uint8Array(32).fill(0x01);
export const HOLDER_SEED = new Uint8Array(32).fill(0x02);
export const OTHER_SEED = new Uint8Array(32).fill(0x03);

/** 픽스처 VC 유효기간(2026-09-14 ~ 2027-09-14) 안의 고정 시각 */
export const NOW = new Date('2026-09-15T00:00:00Z');

export const ISSUER_DID = 'did:dbp:daegu';
export const ISSUER_KID = 'did:dbp:daegu#key-1';
export const VERIFIER_DID = 'did:dbp:verifier-imbank-branch-01';
export const LIST_ID = 'dbp:status:daegu:list-1';
export const EVIDENCE = { bundle: 'daegu-eligibility', version: '2026.1', bundleHash: '0x' + 'ab'.repeat(32) };
