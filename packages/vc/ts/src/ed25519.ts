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

/** 엄격(RFC 8032) 디코딩 후 소수 차수 부분군의 점인지. 디코딩 실패면 false. */
function isTorsionFreePoint(bytes: Uint8Array, allowIdentity: boolean): boolean {
  try {
    const p = ed.Point.fromBytes(bytes, false);
    if (!allowIdentity && p.is0()) return false;
    return p.isTorsionFree();
  } catch {
    return false;
  }
}

/**
 * 32바이트 정규 인코딩이고, small-order·torsion 점이 아닌(소수 차수 부분군의) 공개키인지 (F67).
 * 항등원 같은 small-order 공개키에서는 (R=항등원, S=0) 서명이 어떤 메시지에도 통과하고,
 * 혼합 차수 공개키는 cofactor 유무에 따라 판정이 갈린다. 정상 키(a·B)는 항상 통과한다.
 * Python `ed25519_is_valid_public_key` 와 같은 판정.
 */
export function ed25519IsValidPublicKey(publicKey: Uint8Array): boolean {
  return publicKey.length === 32 && isTorsionFreePoint(publicKey, false);
}

/**
 * Ed25519 검증. 서명 형식이 깨져도 예외 대신 false.
 * Python(OpenSSL)과 판정을 맞춘다 (F67): ZIP-215 대신 RFC 8032 엄격 모드(비정규 A·R·S 거부),
 * small-order·torsion 공개키 거부, R 도 소수 차수 부분군의 점만 허용 — 그러면 noble 의 cofactor 등식이
 * OpenSSL 의 cofactor 없는 등식과 같아진다.
 */
export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || !ed25519IsValidPublicKey(publicKey)) return false;
  if (!isTorsionFreePoint(signature.subarray(0, 32), true)) return false;
  try {
    return ed.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
