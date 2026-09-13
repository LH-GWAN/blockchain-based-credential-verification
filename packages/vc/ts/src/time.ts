import { VcError } from './errors.js';

/** 타임존이 명시된 ISO 8601만 허용한다 (naive 문자열은 JS/Python 해석이 달라지므로 거부). */
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601(타임존 필수) → epoch seconds (정수, 내림). */
export function isoToSeconds(iso: string): number {
  if (typeof iso !== 'string' || !ISO_WITH_TZ.test(iso)) {
    throw new VcError('MALFORMED', `ISO 8601 timestamp with timezone required: ${String(iso)}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new VcError('MALFORMED', `invalid timestamp: ${iso}`);
  return Math.floor(ms / 1000);
}

/** Date → epoch seconds (정수). */
export function dateToSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
