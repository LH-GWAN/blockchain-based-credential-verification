/**
 * 코드 리뷰(2026-10-09) 지갑 쪽 수정 회귀 테스트.
 *  F19 원장 해시 대조 · F31 확인 불가 중립 표시 · F30 증명서 상태 · F39 확인 숫자 · F41 지갑 라벨 우선 · F65 판정 기준일
 *  + 새 거부 사유·오류 코드 문구
 */
import { bundleHash } from '@dbp/rules';
import { loadBundle } from '@dbp/rules/node';
import { createStatusList, encodeStatusList, generateHolderKey, issueVc, setStatus } from '@dbp/vc';
import { describe, expect, it } from 'vitest';
import { confirmCodeOf, vpHashOf } from '@/lib/confirm';
import { COPY } from '@/lib/copy';
import { checkBundleHash, computeClaims, consentLabel, credentialStatusOf, getCitizen, statusRefOf } from '@/lib/eligibility';
import { EVAL_DATE, validEvalDate } from '@/lib/env';
import { REASON_KO, extractCode, messageForCode } from '@/lib/errors';
import { hasAddresses, pickAddresses, revokedIn } from '@/lib/ledger';

const bundle = loadBundle();
const local = bundleHash(bundle);
const OTHER = '0x' + '00'.repeat(32);

describe('F19·F31 규칙 해시: 원장 등록값 → 발급기관 선언값 → 확인 불가', () => {
  it('원장 등록값과 같으면 status=ledger (가장 강한 확인)', () => {
    const r = checkBundleHash(bundle, local, { registered: true, bundleHash: local.toUpperCase().replace('0X', '0x') });
    expect(r.status).toBe('ledger');
    expect(r.ok).toBe(true);
    expect(r.ledger?.toLowerCase()).toBe(local);
  });
  it('원장을 읽지 못하면 발급기관 선언값으로만 — status=declared', () => {
    const r = checkBundleHash(bundle, local, undefined);
    expect(r.status).toBe('declared');
    expect(r.ok).toBe(true);
  });
  it('발급기관 값이 맞아도 원장 값이 다르면 불일치 (발급기관 서버 변조를 잡는다)', () => {
    const r = checkBundleHash(bundle, local, { registered: true, bundleHash: OTHER });
    expect(r.status).toBe('mismatch');
    expect(r.ok).toBe(false);
  });
  it('원장 값이 맞아도 발급기관 선언값이 다르면 불일치', () => {
    expect(checkBundleHash(bundle, OTHER, { registered: true, bundleHash: local }).status).toBe('mismatch');
  });
  it('원장이 응답했지만 미등록이면 unregistered (발급 불가)', () => {
    const r = checkBundleHash(bundle, local, { registered: false });
    expect(r.status).toBe('unregistered');
    expect(r.ok).toBe(false);
  });
  it('발급기관·원장 모두 연결되지 않으면 변조가 아니라 확인 불가 — 중립 문구', () => {
    const r = checkBundleHash(bundle, null, undefined);
    expect(r.status).toBe('unverified');
    expect(r.ok).toBe(false);
    expect(COPY.credentials.hashUnverified).not.toContain('불일치');
    expect(COPY.credentials.hashUnverified).not.toContain('❌');
  });
  it('일치 문구는 모두 "해시 일치 ✓" 로 시작한다 (E2E ① 단언 유지) — 무엇과 대조했는지 함께 밝힌다', () => {
    expect(COPY.credentials.hashLedger.startsWith(COPY.credentials.hashOk)).toBe(true);
    expect(COPY.credentials.hashDeclared.startsWith(COPY.credentials.hashOk)).toBe(true);
    expect(COPY.credentials.hashLedger).toContain('공동원장');
    expect(COPY.credentials.hashDeclared).toContain('발급기관');
  });
});

describe('F30 증명서 상태: 유효기간 + 원장 폐기 비트', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const live = { validUntil: '2027-09-14T00:00:00Z' };
  it('원장에서 폐기되지 않았음이 확인되어야 유효', () => {
    expect(credentialStatusOf(live, now, false)).toBe('valid');
  });
  it('폐기 비트가 서면 폐기됨 (유효기간보다 우선)', () => {
    expect(credentialStatusOf(live, now, true)).toBe('revoked');
    expect(credentialStatusOf({ validUntil: '2026-01-01T00:00:00Z' }, now, true)).toBe('revoked');
  });
  it('유효기간이 지나면 만료됨 (원장 확인과 무관)', () => {
    expect(credentialStatusOf({ validUntil: '2026-10-21T23:59:59Z' }, now, false)).toBe('expired');
    expect(credentialStatusOf({ validUntil: '2026-10-21T23:59:59Z' }, now, null)).toBe('expired');
  });
  it("원장을 읽지 못하면 '유효' 라고 하지 않는다", () => {
    expect(credentialStatusOf(live, now, null)).toBe('unknown');
    expect(credentialStatusOf(live, now, undefined)).toBe('checking');
    expect(COPY.credentials.statusUnknown).not.toBe(COPY.credentials.statusValid);
  });

  it('VC 의 credentialStatus 에서 목록 id·인덱스를 읽고, 원장 비트열에서 폐기 여부를 단말 안에서 판단한다', () => {
    const issuer = generateHolderKey(new Uint8Array(32).fill(7));
    const holder = generateHolderKey(new Uint8Array(32).fill(9));
    const vcJwt = issueVc({
      id: 'urn:uuid:test-1',
      issuerDid: 'did:dbp:welfare',
      issuerKid: 'did:dbp:welfare#key-1',
      issuerPrivateKey: issuer.privateKey,
      holderDid: holder.did,
      claim: { name: 'incomeBelow50Median', value: true },
      validFrom: '2026-09-14T00:00:00Z',
      validUntil: '2026-12-31T14:59:59Z',
      status: { listId: 'dbp:status:welfare:list-1', index: 4242 },
      evidence: { bundle: 'daegu-eligibility', version: '2026.2', bundleHash: local },
    });
    const ref = statusRefOf(vcJwt);
    expect(ref).toEqual({ listId: 'dbp:status:welfare:list-1', index: 4242 });
    const list = createStatusList();
    expect(revokedIn(list, ref!.index)).toBe(false);
    setStatus(list, ref!.index, true);
    expect(revokedIn(list, ref!.index)).toBe(true);
    expect(encodeStatusList(list).length).toBeGreaterThan(0);
    expect(revokedIn(list, list.length * 8 + 1)).toBeNull(); // 범위 밖은 판단 불가
    expect(statusRefOf('not-a-jwt')).toBeNull();
  });
});

describe('공동원장 주소 (빌드 설정 / 배포 정보)', () => {
  it('세 컨트랙트 주소만, 형식이 맞는 것만 고른다', () => {
    const a = pickAddresses({
      RuleRegistry: { address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' },
      StatusListRegistry: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
      ReceiptAnchor: { address: 'nope' },
      IssuerRegistry: { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3' },
    });
    expect(a).toEqual({
      RuleRegistry: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      StatusListRegistry: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    });
    expect(hasAddresses(a)).toBe(true);
    expect(hasAddresses(pickAddresses({ RuleRegistry: '' }))).toBe(false);
    expect(hasAddresses(pickAddresses(undefined))).toBe(false);
  });
});

describe('F39 확인 숫자 · F34 제출물 해시 (검증기관과 같은 계산)', () => {
  // 기대값은 Python: str(int(sha256_hex(s)[:8], 16) % 10000).zfill(4) 로 계산
  it('vpHash = 0x + SHA-256(vpJwt)', () => {
    expect(vpHashOf('abc')).toBe('0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('confirmCode = SHA-256 앞 8자리 % 10000, 4자리 0 채움', () => {
    expect(confirmCodeOf('abc')).toBe('2319');
    expect(confirmCodeOf('eyJhbGciOiJFZERTQSJ9.eyJ0ZXN0IjoxfQ.c2ln')).toBe('3948');
    for (const s of ['a', 'b', 'c', 'vp.jwt.1', 'vp.jwt.2']) expect(confirmCodeOf(s)).toMatch(/^\d{4}$/);
  });
  it('안내 문구에 확인 숫자가 들어간다', () => {
    expect(COPY.present.confirmCode('1234')).toBe('창구 화면의 확인 숫자 1234와 같은지 직원과 확인하세요');
  });
});

describe('F41 제출 동의 화면은 지갑이 아는 항목 이름을 쓴다', () => {
  const labels = bundle.claims.labels;
  it('검증기관이 다른 label 을 보내도 화면에는 번들 라벨, 그리고 불일치 경고', () => {
    const r = consentLabel({ claim: 'isBenefitRecipient', expected: true, label: '대구 거주 여부' }, labels);
    expect(r.label).toBe(labels['isBenefitRecipient']);
    expect(r.label).not.toBe('대구 거주 여부');
    expect(r.mismatch).toBe('대구 거주 여부');
  });
  it('label 이 같거나 없으면 경고 없음', () => {
    expect(consentLabel({ claim: 'daeguResident', expected: true, label: labels['daeguResident'] }, labels).mismatch).toBeNull();
    expect(consentLabel({ claim: 'daeguResident', expected: true }, labels).mismatch).toBeNull();
  });
  it('번들이 없으면 저장된 증명서 라벨, 그것도 없으면 claim id (검증기관 label 은 쓰지 않는다)', () => {
    expect(consentLabel({ claim: 'x', expected: true, label: '가짜' }, {}, { label: '증명서 라벨' })).toEqual({ label: '증명서 라벨', mismatch: '가짜' });
    expect(consentLabel({ claim: 'x', expected: true, label: '가짜' }, {})).toEqual({ label: 'x', mismatch: null });
  });
});

describe('F65 판정 기준일은 발급기관이 알린 evalDate 를 쓴다', () => {
  it('C-014(1961-09-15생): 기본 기준일 2026-09-14 에는 65세 미만, 2026-10-22 에는 65세 이상', () => {
    const c014 = getCitizen('C-014')!;
    expect(EVAL_DATE).toBe('2026-09-14');
    expect(computeClaims(bundle, c014)['ageOver65']).toBe(false);
    expect(computeClaims(bundle, c014, '2026-10-22')['ageOver65']).toBe(true);
  });
  it('날짜 형식 검사', () => {
    expect(validEvalDate('2026-10-22')).toBe('2026-10-22');
    expect(validEvalDate('2026-02-30')).toBeNull();
    expect(validEvalDate('20261022')).toBeNull();
    expect(validEvalDate(undefined)).toBeNull();
  });
});

describe('새 거부 사유·오류 코드 문구 (검증기관 config.py REASON_KO 와 같은 문장)', () => {
  it('거부 사유', () => {
    expect(REASON_KO).toMatchObject({
      ISSUER_NOT_AUTHORITATIVE: '이 항목을 발급할 권한이 없는 기관의 증명서입니다',
      UNREQUESTED_CREDENTIAL: '요청하지 않은 증명서가 함께 제출되었습니다',
      LEDGER_UNAVAILABLE: '공동원장에 연결할 수 없습니다 — 잠시 후 다시 시도하세요',
      RULE_VERSION_NOT_ACCEPTED: '이 창구가 받지 않는 규칙 버전입니다',
      STATUS_LIST_OWNER_MISMATCH: '상태 목록 게시자가 발급기관과 다릅니다',
    });
  });
  it('429 확인번호 조회 제한·결과 권한·요청 항목 오류', () => {
    expect(extractCode({ detail: 'TOO_MANY_LOOKUPS' }, 429)).toBe('TOO_MANY_LOOKUPS');
    expect(messageForCode('TOO_MANY_LOOKUPS')).toContain('확인번호 조회가 너무 많습니다 — 잠시 후 다시 시도하세요');
    expect(messageForCode('RESULT_AUTH_REQUIRED')).toContain('이 결과를 볼 권한이 없습니다');
    expect(messageForCode('RESULT_FORBIDDEN')).toContain('이 결과를 볼 권한이 없습니다');
    expect(messageForCode('REQUESTED_INVALID')).toContain('요청 항목이 올바르지 않습니다');
    expect(messageForCode('REQUEST_UNKNOWN')).toContain('만료');
  });
});

describe('F20·F22 채팅 안내 문구는 서버 동작과 맞는다', () => {
  it("'화면을 닫으면 사라진다' 고 하지 않고, 판정이 아님을 밝힌다", () => {
    expect(COPY.benefits.chatNote).not.toContain('사라집니다');
    expect(COPY.benefits.chatNote).toContain('채팅 답변은 자격 판정이 아닙니다');
    expect(COPY.benefits.chatNote).toContain('30분');
    expect(COPY.benefits.aiPayloadNote.startsWith('원본 수치·이름 없음')).toBe(true); // E2E ② 단언 유지
    expect(COPY.benefits.aiPayloadNote).toContain('직접 입력한 질문');
  });
  it('이력의 해시 대조 문구는 원장 대조라고 하지 않는다 (F25)', () => {
    expect(COPY.history.matchOk).not.toContain('원장');
    expect(COPY.history.matchOk).toBe('영수증 원문·해시 일치 ✓');
  });
});
