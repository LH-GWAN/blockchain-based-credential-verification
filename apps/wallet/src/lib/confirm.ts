/**
 * 제출물(vpJwt) 지문. 검증기관과 같은 계산을 지갑이 직접 한다.
 *  - vpHash: '0x' + SHA-256(vpJwt) — 제출 영수증의 vpHash 와 같고, /results 조회 권한(X-Vp-Hash)으로 쓴다 (F34).
 *  - confirmCode: SHA-256 앞 8자리(16진) 를 10000 으로 나눈 나머지, 4자리 — 창구 화면 숫자와 대조해
 *    창구 앞 사람의 단말에서 제출된 것인지 직원과 확인한다 (F39).
 */
import { sha256Hex } from '@dbp/vc';

export function vpHashOf(vpJwt: string): string {
  return '0x' + sha256Hex(vpJwt);
}

export function confirmCodeOf(vpJwt: string): string {
  const head = sha256Hex(vpJwt).slice(0, 8);
  return String(parseInt(head, 16) % 10000).padStart(4, '0');
}
