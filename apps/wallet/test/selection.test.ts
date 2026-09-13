/** 제출(VP)에는 요청된 claim 과 expected 가 일치하는 VC 만 들어간다 (원자적 VC = 선택적 공개). */
import { describe, expect, it } from 'vitest';
import { selectVcsForRequest } from '@/lib/eligibility';
import type { StoredCredential } from '@/lib/types';

function cred(claim: string, value: boolean, issuer = 'daegu'): StoredCredential {
  return {
    jti: `urn:uuid:${claim}`,
    claim,
    label: claim,
    value,
    vcJwt: `jwt.${claim}.${value}`,
    issuerDid: `did:dbp:${issuer}`,
    issuerName: issuer === 'daegu' ? '대구광역시' : 'iM뱅크',
    statusListIndex: 1,
    validUntil: '2027-09-14T00:00:00Z',
    issuedAt: '2026-09-14T00:00:00Z',
  };
}

const WALLET: StoredCredential[] = [
  cred('daeguResident', true),
  cred('incomeBelow50Median', true),
  cred('ageOver65', true),
  cred('singlePersonHousehold', true),
  cred('creditBottom20', true, 'imbank'),
  cred('hasStudentChild', false), // 방어적: 거짓 VC 가 있어도 expected=true 요청에는 절대 포함되지 않는다
];

describe('selectVcsForRequest', () => {
  it('요청된 claim 의 VC 만, 요청 순서대로 고른다 (다른 증명서는 제외)', () => {
    const sel = selectVcsForRequest(WALLET, [
      { claim: 'daeguResident', expected: true },
      { claim: 'incomeBelow50Median', expected: true },
    ]);
    expect(sel.missing).toEqual([]);
    expect(sel.vcJwts).toEqual(['jwt.daeguResident.true', 'jwt.incomeBelow50Median.true']);
    expect(sel.matched.map((m) => m.credential.issuerName)).toEqual(['대구광역시', '대구광역시']);
    // 65세·1인가구·신용 VC 는 요청되지 않았으므로 제출되지 않는다
    expect(sel.vcJwts.some((j) => j.includes('ageOver65') || j.includes('creditBottom20'))).toBe(false);
  });

  it('expected 와 값이 다르면 매칭하지 않는다', () => {
    const sel = selectVcsForRequest(WALLET, [{ claim: 'hasStudentChild', expected: true }]);
    expect(sel.vcJwts).toEqual([]);
    expect(sel.missing.map((m) => m.claim)).toEqual(['hasStudentChild']);
  });

  it('증명서가 없는 claim 은 missing 으로 보고한다', () => {
    const sel = selectVcsForRequest(WALLET, [
      { claim: 'daeguResident', expected: true },
      { claim: 'incomeBelow32Median', expected: true },
    ]);
    expect(sel.vcJwts).toEqual(['jwt.daeguResident.true']);
    expect(sel.missing.map((m) => m.claim)).toEqual(['incomeBelow32Median']);
  });

  it('expected 생략은 true 로 본다', () => {
    const sel = selectVcsForRequest(WALLET, [{ claim: 'creditBottom20' } as { claim: string; expected: boolean }]);
    expect(sel.vcJwts).toEqual(['jwt.creditBottom20.true']);
    expect(sel.matched[0]?.expected).toBe(true);
  });

  it('빈 지갑이면 전부 missing', () => {
    const sel = selectVcsForRequest([], [{ claim: 'daeguResident', expected: true }]);
    expect(sel.vcJwts).toEqual([]);
    expect(sel.missing).toHaveLength(1);
  });
});
