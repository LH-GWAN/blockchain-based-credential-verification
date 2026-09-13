import type { JsonObject } from './types.js';

/** Python `isinstance(v, int) and not isinstance(v, bool)` — 불리언은 정수가 아니다. */
export function isInt(v: unknown): v is number {
  return Number.isInteger(v);
}

/** JSON 객체(배열·null 제외). Python `dict` 에 대응. */
export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Python `int(v)`: 정수는 그대로, 불리언은 0/1, 정수 문자열은 파싱. 그 외(부동소수점 포함)는 예외. */
export function toInt(v: unknown): number {
  if (isInt(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  throw new TypeError(`int() expects an integer, got ${JSON.stringify(v)}`);
}
