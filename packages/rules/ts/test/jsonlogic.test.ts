/** tests/test_jsonlogic.py 의 미러 + Python 의미와 같아야 하는 엄격성 경계. */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/index.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}
/** Python ValueError 에 해당: Error 이되 TypeError 는 아니다. */
function expectValueError(fn: () => unknown, msg: RegExp): void {
  const e = thrown(fn);
  expect(e).toBeInstanceOf(Error);
  expect(e).not.toBeInstanceOf(TypeError);
  expect((e as Error).message).toMatch(msg);
}

describe('jsonlogic (mirror of test_jsonlogic.py)', () => {
  it('var and compare', () => {
    expect(evaluate({ '<=': [{ var: 'a' }, 3] }, { a: 3 })).toBe(true);
    expect(evaluate({ '<': [{ var: 'a' }, 3] }, { a: 3 })).toBe(false);
    expect(evaluate({ '==': [{ var: 'r.sido' }, '대구광역시'] }, { r: { sido: '대구광역시' } })).toBe(true);
  });

  it('boolean-only logic', () => {
    expect(evaluate({ and: [true, { '!': [false] }] }, {})).toBe(true);
    expect(() => evaluate({ and: [1, true] }, {})).toThrow(TypeError);
    expect(() => evaluate({ if: [1, 'a', 'b'] }, {})).toThrow(TypeError);
  });

  it('integer-only arithmetic', () => {
    expect(evaluate({ '*': [{ var: 'x' }, 100] }, { x: 7 })).toBe(700);
    expect(() => evaluate({ '*': [1.5, 2] }, {})).toThrow(TypeError);
    expect(() => evaluate({ '<=': ['a', 1] }, {})).toThrow(TypeError);
  });

  it('unsupported operator', () => {
    expectValueError(() => evaluate({ max: [1, 2] }, {}), /unsupported operator/);
  });

  it('missing var is null', () => {
    expect(evaluate({ var: 'nope' }, {})).toBeNull();
    expect(evaluate({ '==': [{ var: 'nope' }, null] }, {})).toBe(true);
  });
});

describe('jsonlogic strictness (Python parity)', () => {
  it('booleans are not integers', () => {
    expect(() => evaluate({ '<': [true, 2] }, {})).toThrow(TypeError);
    expect(() => evaluate({ '+': [true, 1] }, {})).toThrow(TypeError);
    expect(() => evaluate({ '==': [true, 1] }, {})).toThrow(TypeError);
    expect(evaluate({ '==': [true, true] }, {})).toBe(true);
  });

  it('== / != accept int/int, str/str, bool/bool, or null on either side', () => {
    expect(evaluate({ '!=': [1, 2] }, {})).toBe(true);
    expect(evaluate({ '==': ['a', 'a'] }, {})).toBe(true);
    expect(evaluate({ '==': [null, 5] }, {})).toBe(false);
    expect(evaluate({ '!=': [{ var: 'x' }, null] }, { x: [1] })).toBe(true);
    expect(() => evaluate({ '==': [1, '1'] }, {})).toThrow(TypeError);
    expect(() => evaluate({ '==': [[1], [1]] }, {})).toThrow(TypeError);
    expectValueError(() => evaluate({ '==': [1] }, {}), /exactly 2 operands/);
  });

  it('and/or short-circuit like Python all()/any() over a generator', () => {
    expect(evaluate({ and: [false, 1] }, {})).toBe(false); // 1 은 평가되지 않는다
    expect(() => evaluate({ and: [true, 1] }, {})).toThrow(TypeError);
    expect(evaluate({ or: [true, 1] }, {})).toBe(true);
    expect(() => evaluate({ or: [false, 1] }, {})).toThrow(TypeError);
    expect(evaluate({ and: [] }, {})).toBe(true);
    expect(evaluate({ or: [] }, {})).toBe(false);
    expect(() => evaluate({ '!': [0] }, {})).toThrow(TypeError);
  });

  it('rule object must have exactly one operator key', () => {
    expectValueError(() => evaluate({ '==': [1, 1], '!=': [1, 2] }, {}), /exactly one operator key/);
    expectValueError(() => evaluate({}, {}), /exactly one operator key/);
    expectValueError(() => evaluate({ if: [true, 1] }, {}), /cond, then, else/);
  });

  it('float literals are rejected anywhere', () => {
    expect(() => evaluate(1.5, {})).toThrow(TypeError);
    expect(() => evaluate({ '+': [1, 2.5] }, {})).toThrow(TypeError);
    expect(() => evaluate({ '<': [{ var: 'x' }, 1] }, { x: 0.5 })).toThrow(TypeError);
  });

  it('literals and arrays evaluate to themselves; non-array args are wrapped', () => {
    expect(evaluate('x', {})).toBe('x');
    expect(evaluate(null, {})).toBeNull();
    expect(evaluate([1, 2], {})).toEqual([1, 2]);
    expect(evaluate({ var: 'a' }, { a: 1 })).toBe(1);
    expect(evaluate({ '!': true }, {})).toBe(false);
  });

  it('var: dotted path, non-object hops and prototype keys give null', () => {
    expect(evaluate({ var: 'a.b.c' }, { a: { b: { c: 'ok' } } })).toBe('ok');
    expect(evaluate({ var: 'a.b' }, { a: 1 })).toBeNull();
    expect(evaluate({ var: 'a.0' }, { a: [9] })).toBeNull(); // Python: list 는 dict 가 아니다
    expect(evaluate({ var: 'constructor' }, {})).toBeNull();
    expect(evaluate({ var: 'a' }, [1])).toBeNull();
  });

  it('in: needle in list with Python == semantics', () => {
    expect(evaluate({ in: ['a', ['a', 'b']] }, {})).toBe(true);
    expect(evaluate({ in: [{ var: 'n' }, [1, 2, 3]] }, { n: 4 })).toBe(false);
    expect(evaluate({ in: [1, [true]] }, {})).toBe(true); // Python: True == 1
    expect(evaluate({ in: [[1, 2], [[1, 2]]] }, {})).toBe(true);
    expect(() => evaluate({ in: [1, 'abc'] }, {})).toThrow(TypeError);
  });

  it('* and + fold over integers; empty → identity; overflow throws instead of drifting', () => {
    expect(evaluate({ '+': [1, 2, 3] }, {})).toBe(6);
    expect(evaluate({ '*': [2, 3, 4] }, {})).toBe(24);
    expect(evaluate({ '*': [] }, {})).toBe(1);
    expect(evaluate({ '+': [] }, {})).toBe(0);
    expect(evaluate({ '*': [-3, 4] }, {})).toBe(-12);
    expect(() => evaluate({ '*': [2 ** 40, 2 ** 40] }, {})).toThrow(RangeError);
  });
});
