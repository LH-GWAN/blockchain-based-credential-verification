import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { canonicalize, sha256Hex } from './jcs.js';

/**
 * §6.8 영수증 해시 = '0x' + SHA-256(JCS(obj)). ReceiptAnchor.anchor(bytes32) 입력.
 * consent: { kind:"consent", holderDid, issuerDid, claims, ts, salt }
 * presentation: { kind:"presentation", vpHash, verifierDid, nonce, ts, salt }
 */
export function receiptHash(obj: Record<string, unknown>): string {
  return '0x' + sha256Hex(canonicalize(obj));
}

/** 32바이트 난수 salt, hex 64자 (0x 없음). 원문+salt는 지갑만 보관. */
export function randomSalt(): string {
  return bytesToHex(randomBytes(32));
}

/** 검증 요청 nonce: `n_` + 16바이트 hex. */
export function randomNonce(): string {
  return 'n_' + bytesToHex(randomBytes(16));
}
