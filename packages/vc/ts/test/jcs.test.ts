import { describe, expect, it } from 'vitest';
import { VcError, bundleHash, canonicalize, sha256Hex } from '../src/index.js';

describe('canonicalize (JCS)', () => {
  it('sorts keys and removes whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  });

  it('orders keys by UTF-16 code units (digits < upper < _ < lower < 한글)', () => {
    expect(canonicalize({ b: 0, a: 0, B: 0, _: 0, '0': 0, '가': 0, '': 0 })).toBe(
      '{"":0,"0":0,"B":0,"_":0,"a":0,"b":0,"가":0}',
    );
  });

  it('keeps non-ASCII as-is and escapes JSON specials with lowercase \\u00xx', () => {
    expect(canonicalize({ k: '대구광역시', e: 'q"b\\c\n\t\u0001\u001f' })).toBe(
      '{"e":"q\\"b\\\\c\\n\\t\\u0001\\u001f","k":"대구광역시"}',
    );
  });

  it('handles scalars and empties', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize('s')).toBe('"s"');
    expect(canonicalize(9007199254740991)).toBe('9007199254740991');
    expect(canonicalize(-42)).toBe('-42');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });

  it('rejects floats, NaN and Infinity (project-wide invariant)', () => {
    for (const bad of [1.5, -0.1, NaN, Infinity, 2 ** 53]) {
      expect(() => canonicalize({ x: bad })).toThrowError(VcError);
      try {
        canonicalize([bad]);
      } catch (e) {
        expect((e as VcError).code).toBe('FLOAT_FORBIDDEN');
      }
    }
  });

  it('omits undefined object members but rejects undefined array items and functions', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalize([undefined])).toThrowError(VcError);
    expect(() => canonicalize({ f: () => 1 })).toThrowError(VcError);
    expect(() => canonicalize(new Uint8Array(2))).toThrowError(VcError);
  });

  it('is independent of insertion order', () => {
    expect(canonicalize({ x: { b: 1, a: 2 }, y: 3 })).toBe(canonicalize({ y: 3, x: { a: 2, b: 1 } }));
  });
});

describe('sha256Hex / bundleHash', () => {
  it('matches known SHA-256 vectors', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });

  it('bundleHash = 0x + sha256(JCS)', () => {
    const obj = { rules: { ageOver65: { '>=': [{ var: 'age' }, 65] } }, version: '2026.1' };
    expect(bundleHash(obj)).toBe('0x' + sha256Hex(canonicalize(obj)));
    expect(bundleHash(obj)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bundleHash({ version: '2026.1', rules: { ageOver65: { '>=': [{ var: 'age' }, 65] } } })).toBe(bundleHash(obj));
  });
});
