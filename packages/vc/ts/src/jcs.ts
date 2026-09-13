import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { VcError } from './errors.js';

/**
 * JCS (RFC 8785) 정규화. 키는 UTF-16 코드유닛 순 정렬, 공백 없음, 문자열은 JSON.stringify 규칙으로 이스케이프.
 * 프로젝트 전체에서 부동소수점은 금지이므로 정수가 아닌 number는 예외를 던진다.
 * Python 쪽 `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)` 와 바이트 단위로 일치한다.
 * (객체의 undefined 값 키는 JSON.stringify와 같이 생략한다.)
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isSafeInteger(v)) throw new VcError('FLOAT_FORBIDDEN', `non-integer number not allowed: ${v}`);
      return String(v); // -0 → "0"
    case 'bigint':
      return v.toString();
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']';
      if (ArrayBuffer.isView(v)) throw new VcError('MALFORMED', 'binary data cannot be canonicalized; hex-encode it first');
      const obj = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const val = obj[key];
        if (val === undefined) continue;
        parts.push(JSON.stringify(key) + ':' + serialize(val));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new VcError('MALFORMED', `cannot canonicalize value of type ${typeof v}`);
  }
}

/** SHA-256 hex (0x 없음). 문자열은 UTF-8로 인코딩한다. */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8ToBytes(input) : input;
  return bytesToHex(sha256(bytes));
}

/** 번들 해시 = '0x' + SHA-256(JCS(obj)). RuleRegistry.registerBundle(bytes32) 입력과 동일. */
export function bundleHash(obj: unknown): string {
  return '0x' + sha256Hex(canonicalize(obj));
}
