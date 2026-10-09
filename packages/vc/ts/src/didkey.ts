import { base58 } from '@scure/base';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { ed25519IsValidPublicKey, ed25519PublicKey } from './ed25519.js';
import { VcError } from './errors.js';

/** multicodec ed25519-pub (0xed) 의 varint 표현. */
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
const DID_KEY_PREFIX = 'did:key:z';
/** base58btc 알파벳 + 선택적 fragment. 공백·개행·다른 문자는 받지 않는다 (Python 과 같은 정규식, F68). */
const DID_KEY_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+(?:#[A-Za-z0-9._~-]+)?$/;

export interface HolderKey {
  /** 32바이트 Ed25519 시드. 지갑 IndexedDB에만 저장, 절대 전송 금지. */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  did: string;
}

/** Ed25519 공개키 → `did:key:z6Mk...` (multicodec 0xed01 + base58btc, multibase 'z'). */
export function publicKeyToDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new VcError('MALFORMED', 'Ed25519 public key must be 32 bytes');
  return DID_KEY_PREFIX + base58.encode(concatBytes(ED25519_MULTICODEC, publicKey));
}

/**
 * `did:key:z6Mk...`(fragment 허용) → Ed25519 공개키 32바이트.
 * small-order·torsion 공개키(예: 항등원)는 MALFORMED 로 거부한다 (F67).
 */
export function didKeyToPublicKey(did: string): Uint8Array {
  if (typeof did !== 'string' || !DID_KEY_RE.test(did)) throw new VcError('MALFORMED', `not a did:key (base58btc): ${String(did)}`);
  const bare = did.split('#')[0]!;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(bare.slice(DID_KEY_PREFIX.length));
  } catch {
    throw new VcError('MALFORMED', 'did:key is not valid base58btc');
  }
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new VcError('MALFORMED', 'did:key is not an Ed25519 key');
  }
  const publicKey = bytes.slice(2);
  if (!ed25519IsValidPublicKey(publicKey)) {
    throw new VcError('MALFORMED', 'did:key public key is small-order or not in the prime-order subgroup');
  }
  return publicKey;
}

/** holder 키 생성. seed(32바이트)를 주면 결정론적, 없으면 CSPRNG. */
export function generateHolderKey(seed?: Uint8Array): HolderKey {
  const privateKey = seed ?? randomBytes(32);
  if (privateKey.length !== 32) throw new VcError('MALFORMED', 'seed must be 32 bytes');
  const publicKey = ed25519PublicKey(privateKey);
  return { privateKey, publicKey, did: publicKeyToDidKey(publicKey) };
}
