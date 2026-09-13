/**
 * Python `json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)` 와 바이트 단위로 동일한 정규화.
 * - 객체 키는 코드포인트 순 정렬 (Python str 비교와 동일. JS 기본 sort 는 UTF-16 코드유닛 순이라
 *   U+FFFF 와 U+1F600 같은 보조평면 문자의 순서가 뒤바뀐다).
 * - 문자열: `"` `\` 와 \b \f \n \r \t 는 짧은 이스케이프, 그 외 0x20 미만 제어문자는 \u00xx(소문자 16진수),
 *   비ASCII(한글·이모지·U+2028 등)와 DEL(0x7f)은 원문 그대로.
 * - 숫자는 안전한 정수만 허용. 부동소수점·2^53 초과·undefined·bigint 는 예외 (조용히 다른 바이트를 내지 않는다).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const SHORT: Record<string, string | undefined> = {
  '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t',
};
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function quote(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new Error('lone surrogate cannot be UTF-8 encoded');
  return '"' + s.replace(/[\u0000-\u001f"\\]/g, (c) => SHORT[c] ?? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
}

/** Python str 비교 = 유니코드 코드포인트 순. */
function cmpCodePoints(a: string, b: string): number {
  const xa = Array.from(a);
  const xb = Array.from(b);
  const n = Math.min(xa.length, xb.length);
  for (let i = 0; i < n; i++) {
    const d = (xa[i] as string).codePointAt(0)! - (xb[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return xa.length - xb.length;
}

function ser(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return quote(v);
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error(`float not allowed at ${path}`);
      return String(v); // -0 → "0"
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x, i) => ser(x, `${path}[${i}]`)).join(',') + ']';
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort(cmpCodePoints);
      return '{' + keys.map((k) => quote(k) + ':' + ser(o[k], `${path}.${k}`)).join(',') + '}';
    }
    default:
      throw new Error(`cannot canonicalize ${typeof v} at ${path}`);
  }
}

export function canonicalize(value: unknown): string {
  return ser(value, '$');
}

/** SHA-256 hex (0x 없음). 문자열은 UTF-8 로 인코딩한다. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}
