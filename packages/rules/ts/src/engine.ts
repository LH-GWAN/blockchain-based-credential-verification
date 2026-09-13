/** 전처리 → claim 판정 → 정책 판정, 범주값 프로필. Python `dbp_rules.engine` 과 동일. */
import { evaluate } from './jsonlogic.js';
import type { Bundle, CategoricalProfile, ClaimMap, Json, JsonObject, PolicyMap } from './types.js';
import { isPlainObject, toInt } from './util.js';

export const DEFAULT_EVAL_DATE = '2026-09-14';

/** 달력 날짜 (연, 월, 일). 타임존에 영향받지 않도록 문자열을 직접 쪼개고 튜플로 비교한다. */
export type Ymd = readonly [number, number, number];
/**
 * 'YYYY-MM-DD' 문자열(권장) 또는 Date. Date 는 UTC 달력 날짜로 읽는다
 * (`new Date('2026-09-14')` 는 어느 타임존에서나 2026-09-14).
 */
export type DateLike = string | Date;

export function toYmd(d: DateLike): Ymd {
  if (d instanceof Date) return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
  if (!m) throw new Error(`invalid ISO date: ${String(d)}`);
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, day)); // Python date.fromisoformat 처럼 존재하지 않는 날짜는 거부
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== day) throw new Error(`invalid date: ${d}`);
  return [y, mo, day];
}

/** 만 나이: 연도 차이에서, 기준일의 (월, 일) 이 생일의 (월, 일) 보다 앞서면 1 을 뺀다. */
function ageOn(birth: Json, asOf: Ymd): number {
  if (typeof birth !== 'string') throw new TypeError('ageOn expects an ISO date string');
  const [by, bm, bd] = toYmd(birth);
  const [y, m, d] = asOf;
  let years = y - by;
  if (m < bm || (m === bm && d < bd)) years -= 1;
  return years;
}

/** 점 경로 조회 (Python `_get`: dict.get 연쇄, 없으면 None). */
function get(data: Json, path: string): Json {
  let cur: Json = data;
  for (const part of path.split('.')) cur = isPlainObject(cur) && Object.hasOwn(cur, part) ? (cur[part] ?? null) : null;
  return cur;
}

/** Python `str()` — lookup 키 문자열화 (None→"None", True→"True"). */
function pyStr(v: Json): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  throw new TypeError('lookup key must be a primitive');
}

/** 원본 프로필에 파생값을 합쳐 규칙 입력 데이터를 만든다. 원본은 변경하지 않는다. */
export function preprocess(bundle: Bundle, profile: JsonObject, asOf: DateLike = DEFAULT_EVAL_DATE): JsonObject {
  const ymd = toYmd(asOf);
  const data: JsonObject = { ...profile };
  // 입력이 없으면 파생값도 null (Python 과 동일). 발급기관마다 아는 필드가 다르므로 — 은행은 가구원수를 모른다 —
  // 자기 소관 claim 만 평가하면 된다. null 이 섞인 claim 을 평가하면 jsonlogic 이 TypeError 를 낸다.
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  for (const d of bundle.preprocess.derived) {
    const src: Json = 'from' in d ? (data[d.from] ?? null) : null;
    switch (d.op) {
      case 'ageOn':
        data[d.name] = typeof src === 'string' ? ageOn(src, ymd) : null;
        break;
      case 'birthYear':
        data[d.name] = typeof src === 'string' ? toInt(src.slice(0, 4)) : null;
        break;
      case 'get':
        data[d.name] = get(data, d.path);
        break;
      case 'clampInt':
        data[d.name] = isInt(src) ? Math.max(toInt(d.min), Math.min(toInt(d.max), src)) : null;
        break;
      case 'lookup': {
        const key = evaluate(d.keyExpr, data);
        const table = (bundle.tables as unknown as Record<string, Json>)[d.table];
        if (key === null || key === undefined) { data[d.name] = null; break; }
        const skey = pyStr(key);
        data[d.name] = isPlainObject(table) && Object.hasOwn(table, skey) ? (table[skey] as Json) : null;
        break;
      }
      case 'expr':
        data[d.name] = evaluate(d.expr, data);
        break;
      default:
        throw new Error(`unknown preprocess op ${(d as { op: string }).op}`);
    }
  }
  return data;
}

export function evaluateClaims(
  bundle: Bundle,
  profile: JsonObject,
  asOf: DateLike = DEFAULT_EVAL_DATE,
  only?: readonly string[],
): ClaimMap {
  const data = preprocess(bundle, profile, asOf);
  const rules = bundle.claims.rules;
  const names = only && only.length > 0 ? only : Object.keys(rules); // Python `only or list(rules)`
  const out: ClaimMap = {};
  for (const name of names) {
    if (!Object.hasOwn(rules, name)) throw new Error(`unknown claim ${name}`);
    const v = evaluate(rules[name] as Json, data);
    if (typeof v !== 'boolean') throw new TypeError(`claim ${name} must evaluate to boolean`);
    out[name] = v;
  }
  return out;
}

/** claim 불리언만으로 정책 적격 판정. 원본 프로필 불필요 (검증기관도 실행 가능). */
export function evaluatePolicies(bundle: Bundle, claims: ClaimMap): PolicyMap {
  const out: PolicyMap = {};
  for (const [pid, rule] of Object.entries(bundle.policies.rules)) {
    const v = evaluate(rule, claims);
    if (typeof v !== 'boolean') throw new TypeError(`policy ${pid} must evaluate to boolean`);
    out[pid] = v;
  }
  return out;
}

/** AI 서비스에 전달 가능한 범주값. 원본 수치는 절대 포함하지 않는다. */
export function categoricalProfile(claims: ClaimMap, householdSize: number): CategoricalProfile {
  const bracket = claims['incomeBelow32Median'] ? '≤32%'
    : claims['incomeBelow48Median'] ? '≤48%'
    : claims['incomeBelow50Median'] ? '≤50%'
    : '>50%';
  const status = claims['isBenefitRecipient'] ? 'recipient' : claims['incomeBelow50Median'] ? 'near-poor' : 'none';
  return {
    ageBand: claims['ageOver65'] ? '65+' : '<65',
    householdSize: Math.max(1, Math.min(6, toInt(householdSize))),
    residence: claims['daeguResident'] ? 'daegu' : 'other',
    incomeBracket: bracket,
    recipientStatus: status,
    creditTier: claims['creditBottom20'] ? 'bottom20' : 'other',
  };
}
