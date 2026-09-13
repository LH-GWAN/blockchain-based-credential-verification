import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { VcError } from './errors.js';

// @noble/ed25519 v3는 동기 API를 쓰려면 sha512를 주입해야 한다 (브라우저·Node 공통).
ed.hashes.sha512 = sha512;

/** 32바이트 시드(비밀키)에서 Ed25519 공개키(32바이트)를 계산한다. */
export function ed25519PublicKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) throw new VcError('MALFORMED', 'Ed25519 private key must be 32 bytes');
  return ed.getPublicKey(privateKey);
}

/** 온체인 IssuerRegistry.register(bytes32) 용 `0x` + 64 hex 공개키. */
export function ed25519PublicKeyHex(privateKey: Uint8Array): string {
  return '0x' + bytesToHex(ed25519PublicKey(privateKey));
}

/** Ed25519 서명 (64바이트, 결정론적). */
export function ed25519Sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) throw new VcError('MALFORMED', 'Ed25519 private key must be 32 bytes');
  return ed.sign(message, privateKey);
}

/** Ed25519 검증. 서명 형식이 깨져도 예외 대신 false. */
export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
