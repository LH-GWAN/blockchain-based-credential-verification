import { base58 } from '@scure/base';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { ed25519PublicKey } from './ed25519.js';
import { VcError } from './errors.js';

/** multicodec ed25519-pub (0xed) 의 varint 표현. */
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
const DID_KEY_PREFIX = 'did:key:z';

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

/** `did:key:z6Mk...`(fragment 허용) → Ed25519 공개키 32바이트. */
export function didKeyToPublicKey(did: string): Uint8Array {
  const bare = did.split('#')[0]!;
  if (!bare.startsWith(DID_KEY_PREFIX)) throw new VcError('MALFORMED', `not a did:key (base58btc): ${did}`);
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(bare.slice(DID_KEY_PREFIX.length));
  } catch {
    throw new VcError('MALFORMED', 'did:key is not valid base58btc');
  }
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new VcError('MALFORMED', 'did:key is not an Ed25519 key');
  }
  return bytes.slice(2);
}

/** holder 키 생성. seed(32바이트)를 주면 결정론적, 없으면 CSPRNG. */
export function generateHolderKey(seed?: Uint8Array): HolderKey {
  const privateKey = seed ?? randomBytes(32);
  if (privateKey.length !== 32) throw new VcError('MALFORMED', 'seed must be 32 bytes');
  const publicKey = ed25519PublicKey(privateKey);
  return { privateKey, publicKey, did: publicKeyToDidKey(publicKey) };
}
