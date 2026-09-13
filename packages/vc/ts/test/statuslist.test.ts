import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUS_LIST_SIZE,
  VcError,
  createStatusList,
  decodeStatusList,
  encodeStatusList,
  getStatus,
  setStatus,
} from '../src/index.js';

describe('Bitstring Status List', () => {
  it('creates a zeroed list of 131072 bits by default', () => {
    const list = createStatusList();
    expect(DEFAULT_STATUS_LIST_SIZE).toBe(131072);
    expect(list.length).toBe(16384);
    expect(list.every((b) => b === 0)).toBe(true);
    expect(createStatusList(64).length).toBe(8);
    for (const bad of [0, -8, 12, 8.5]) expect(() => createStatusList(bad)).toThrowError(VcError);
  });

  it('places bit i in byte i>>3, MSB first', () => {
    const list = createStatusList(64);
    setStatus(list, 0, true);
    expect(list[0]).toBe(0x80);
    setStatus(list, 7, true);
    expect(list[0]).toBe(0x81);
    setStatus(list, 8, true);
    expect(list[1]).toBe(0x80);
    setStatus(list, 63, true);
    expect(list[7]).toBe(0x01);
    expect(getStatus(list, 0)).toBe(true);
    expect(getStatus(list, 1)).toBe(false);
    expect(getStatus(list, 7)).toBe(true);
    expect(getStatus(list, 8)).toBe(true);
    expect(getStatus(list, 63)).toBe(true);
    setStatus(list, 0, false);
    expect(list[0]).toBe(0x01);
    expect(getStatus(list, 0)).toBe(false);
  });

  it('rejects out-of-range or non-integer indices', () => {
    const list = createStatusList(64);
    for (const bad of [-1, 64, 1.5, NaN]) {
      expect(() => getStatus(list, bad)).toThrowError(VcError);
      expect(() => setStatus(list, bad, true)).toThrowError(VcError);
    }
  });

  it('encodes as base64url(gzip) without padding and round-trips', () => {
    const list = createStatusList();
    const revoked = [0, 7, 8, 1042, 65535, 131071];
    for (const i of revoked) setStatus(list, i, true);
    const encoded = encodeStatusList(list);
    expect(encoded.startsWith('H4sI')).toBe(true); // gzip magic 1f 8b
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded.length).toBeLessThan(200); // 16KiB of mostly zeros compresses well
    const decoded = decodeStatusList(encoded);
    expect(decoded.length).toBe(list.length);
    expect(decoded).toEqual(list);
    for (let i = 0; i < 131072; i++) {
      if (getStatus(decoded, i) !== revoked.includes(i)) throw new Error(`bit ${i} mismatch`);
    }
    expect(decodeStatusList('u' + encoded)).toEqual(list); // multibase 'u' 접두어 허용
  });

  it('rejects garbage', () => {
    expect(() => decodeStatusList('not-gzip')).toThrowError(VcError);
    expect(() => decodeStatusList('@@')).toThrowError(VcError);
  });
});
