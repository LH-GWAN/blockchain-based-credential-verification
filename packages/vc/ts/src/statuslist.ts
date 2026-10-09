import { base64urlnopad } from '@scure/base';
import { gzip, ungzip } from 'pako';
import { VcError } from './errors.js';
import { b64urlDecode } from './jws.js';

/** W3C Bitstring Status List v1.0 최소 크기 (131,072비트 = 16KiB). */
export const DEFAULT_STATUS_LIST_SIZE = 131072;

/** 모두 0(정상)인 비트열. size는 비트 수, 8의 배수. */
export function createStatusList(size: number = DEFAULT_STATUS_LIST_SIZE): Uint8Array {
  if (!Number.isSafeInteger(size) || size <= 0 || size % 8 !== 0) {
    throw new VcError('MALFORMED', 'status list size must be a positive multiple of 8');
  }
  return new Uint8Array(size / 8);
}

function locate(list: Uint8Array, index: number): { byte: number; mask: number } {
  if (!Number.isSafeInteger(index) || index < 0 || index >= list.length * 8) {
    throw new VcError('MALFORMED', `status list index out of range: ${index}`);
  }
  // 비트 i는 바이트 i>>3 의 MSB부터 (mask 0x80 >> (i & 7))
  return { byte: index >> 3, mask: 0x80 >> (index & 7) };
}

/** 비트 설정 (in place). revoked=true → 1. */
export function setStatus(list: Uint8Array, index: number, revoked: boolean): void {
  const { byte, mask } = locate(list, index);
  if (revoked) list[byte]! |= mask;
  else list[byte]! &= ~mask & 0xff;
}

/** 폐기 여부 조회. */
export function getStatus(list: Uint8Array, index: number): boolean {
  const { byte, mask } = locate(list, index);
  return (list[byte]! & mask) !== 0;
}

/** gzip → base64url(패딩 없음). 체인 StatusListRegistry.publish 의 encodedList. */
export function encodeStatusList(list: Uint8Array): string {
  return base64urlnopad.encode(gzip(list));
}

/**
 * base64url → gunzip. Python(zlib) 인코딩도 그대로 디코딩된다 (gzip 헤더만 다르고 스트림 호환).
 * multibase 'u' 접두어가 붙은 W3C 표준 표현(uH4sI...)도 허용한다.
 */
export function decodeStatusList(encoded: string): Uint8Array {
  const raw = encoded.startsWith('uH4sI') ? encoded.slice(1) : encoded;
  try {
    return ungzip(b64urlDecode(raw));
  } catch {
    throw new VcError('MALFORMED', 'encoded status list is not base64url(gzip)');
  }
}
