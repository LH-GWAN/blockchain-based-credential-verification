/**
 * JSON Logic 부분집합 평가기 — Python `dbp_rules.jsonlogic` 과 의미가 동일하다.
 *
 * 지원 연산자: var, if, and, or, !, ==, !=, <, <=, >, >=, in, *, +
 * - and/or/!/if 의 피연산자는 반드시 불리언. 아니면 TypeError.
 * - < <= > >= 와 * + 는 정수만(불리언은 정수가 아니다).
 * - == != 는 int/int, str/str, bool/bool 이거나 한쪽이 null 일 때만.
 * - float 리터럴은 어디서도 허용하지 않는다. 없는 변수는 null.
 * - 규칙 객체는 연산자 키를 정확히 하나만 가진다.
 * 오류 종류: 타입 위반 → TypeError, 규칙 형식 위반(Python ValueError) → Error.
 */
import type { Json, Rule } from './types.js';
import { isInt, isPlainObject } from './util.js';

export const SUPPORTED = ['var', 'if', 'and', 'or', '!', '==', '!=', '<', '<=', '>', '>=', 'in', '*', '+'] as const;
type Op = (typeof SUPPORTED)[number];

/** 점(.)으로 구분된 경로. 중간에 객체가 아니거나 키가 없으면 null (Python `_get_var`). */
function getVar(data: Json, path: Json): Json {
  let cur: Json = data;
  for (const part of String(path).split('.')) {
    if (isPlainObject(cur) && Object.hasOwn(cur, part)) cur = cur[part] ?? null;
    else return null;
  }
  return cur;
}

function requireBool(v: Json, op: string): boolean {
  if (typeof v !== 'boolean') throw new TypeError(`'${op}' expects boolean operands, got ${v === null ? 'null' : typeof v}`);
  return v;
}

function compare(op: Op, a: Json, b: Json): boolean {
  if (op === '==' || op === '!=') {
    const ok =
      (isInt(a) && isInt(b)) ||
      (typeof a === 'string' && typeof b === 'string') ||
      (typeof a === 'boolean' && typeof b === 'boolean') ||
      a === null ||
      b === null;
    if (!ok) throw new TypeError(`'${op}' operands must be same primitive type`);
    return op === '==' ? a === b : a !== b;
  }
  if (!(isInt(a) && isInt(b))) throw new TypeError(`'${op}' requires integers`);
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    default: return a >= b;
  }
}

/** Python `==` (`in` 연산자의 원소 비교용): 숫자·불리언은 수치로(True == 1), 배열·객체는 깊은 비교. */
function pyEquals(a: Json, b: Json): boolean {
  if ((typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'boolean')) {
    return Number(a) === Number(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEquals(x, b[i] as Json));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && pyEquals(a[k] as Json, b[k] as Json));
  }
  return a === b;
}

export function evaluate(rule: Rule, data: Json): Json {
  if (typeof rule === 'number' && !Number.isInteger(rule)) throw new TypeError('float literal not allowed in rules');
  if (!isPlainObject(rule)) return rule; // 리터럴(불리언·정수·문자열·null·배열)은 그대로
  const keys = Object.keys(rule);
  if (keys.length !== 1) throw new Error('rule object must have exactly one operator key');
  const op = keys[0] as string;
  if (!(SUPPORTED as readonly string[]).includes(op)) throw new Error(`unsupported operator: ${op}`);
  const raw = rule[op] as Json;
  const args: Json[] = Array.isArray(raw) ? raw : [raw];

  switch (op as Op) {
    case 'var':
      if (args.length < 1) throw new Error("'var' requires a path");
      return getVar(data, args[0] as Json);
    case 'if': {
      if (args.length !== 3) throw new Error("'if' requires [cond, then, else]");
      const cond = requireBool(evaluate(args[0] as Json, data), 'if');
      return evaluate((cond ? args[1] : args[2]) as Json, data);
    }
    case 'and': // Python all(generator): 첫 false 에서 멈춘다 (이후 피연산자는 평가·검사하지 않음)
      for (const a of args) if (!requireBool(evaluate(a, data), 'and')) return false;
      return true;
    case 'or': // Python any(generator): 첫 true 에서 멈춘다
      for (const a of args) if (requireBool(evaluate(a, data), 'or')) return true;
      return false;
    case '!':
      if (args.length < 1) throw new Error("'!' requires 1 operand");
      return !requireBool(evaluate(args[0] as Json, data), '!');
    case '==': case '!=': case '<': case '<=': case '>': case '>=': {
      if (args.length !== 2) throw new Error(`'${op}' requires exactly 2 operands`);
      return compare(op as Op, evaluate(args[0] as Json, data), evaluate(args[1] as Json, data));
    }
    case 'in': {
      if (args.length < 2) throw new Error("'in' requires [needle, list]");
      const needle = evaluate(args[0] as Json, data);
      const hay = evaluate(args[1] as Json, data);
      if (!Array.isArray(hay)) throw new TypeError("'in' requires a list");
      return hay.some((h) => pyEquals(needle, h));
    }
    case '*': case '+': {
      const vals = args.map((a) => evaluate(a, data));
      if (!vals.every(isInt)) throw new TypeError(`'${op}' requires integers`);
      let acc = op === '*' ? 1 : 0;
      for (const v of vals as number[]) {
        acc = op === '*' ? acc * v : acc + v;
        // Python 은 임의 정밀도 정수. JS 는 2^53 을 넘으면 값이 달라지므로 조용히 틀리는 대신 예외.
        if (!Number.isSafeInteger(acc)) throw new RangeError(`'${op}' result exceeds safe integer range`);
      }
      return acc;
    }
  }
}
