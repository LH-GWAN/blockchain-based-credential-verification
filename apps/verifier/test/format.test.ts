import { describe, expect, it } from "vitest";
import { PRESETS_FALLBACK } from "../src/lib/copy";
import {
  attackOutcome,
  credentialValueLabel,
  factLabel,
  formatCountdown,
  formatMs,
  formatSeconds,
  groupShortCode,
  issuerNames,
  policyCheckNotes,
  presetCounterCheckedNote,
  receivedFactCount,
  remainingSeconds,
  shortHash,
  statusLabel,
} from "../src/lib/format";

describe("formatSeconds", () => {
  it("ms → 0.xx초", () => {
    expect(formatSeconds(830)).toBe("0.83초");
    expect(formatSeconds(1234.5)).toBe("1.23초");
    expect(formatSeconds(5)).toBe("0.01초");
    expect(formatSeconds(0)).toBe("0.00초");
  });
  it("음수·NaN 은 0 으로", () => {
    expect(formatSeconds(-10)).toBe("0.00초");
    expect(formatSeconds(Number.NaN)).toBe("0.00초");
  });
});

describe("formatMs", () => {
  it("1ms 이상은 정수, 미만은 소수 1자리", () => {
    expect(formatMs(12.345)).toBe("12ms");
    expect(formatMs(0.42)).toBe("0.4ms");
    expect(formatMs(0)).toBe("0.0ms");
  });
});

describe("formatCountdown", () => {
  it("mm:ss", () => {
    expect(formatCountdown(119)).toBe("01:59");
    expect(formatCountdown(120)).toBe("02:00");
    expect(formatCountdown(7)).toBe("00:07");
    expect(formatCountdown(0)).toBe("00:00");
  });
  it("음수·소수는 00:00 / 내림", () => {
    expect(formatCountdown(-5)).toBe("00:00");
    expect(formatCountdown(59.9)).toBe("00:59");
  });
});

describe("remainingSeconds", () => {
  it("만료 시각까지 남은 초(올림, 0 이상)", () => {
    const now = 1_800_000_000_000; // ms
    expect(remainingSeconds(1_800_000_120, now)).toBe(120);
    expect(remainingSeconds(1_800_000_000 + 0.2, now)).toBe(1);
    expect(remainingSeconds(1_799_999_000, now)).toBe(0);
  });
});

describe("groupShortCode / shortHash", () => {
  it("6자리 코드는 3-3 으로", () => {
    expect(groupShortCode("123456")).toBe("123 456");
    expect(groupShortCode("12345")).toBe("12345");
  });
  it("해시 축약", () => {
    expect(shortHash("0x1234567890abcdef1234567890abcdef")).toBe("0x12345678…abcdef");
    expect(shortHash("short")).toBe("short");
    expect(shortHash(null)).toBe("—");
  });
});

describe("statusLabel", () => {
  it("PASS → 유효, 사유 코드 우선순위", () => {
    expect(statusLabel({ verdict: "PASS", reasonCodes: [] })).toBe("유효");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["REVOKED", "CLAIM_MISSING"] })).toBe("폐기됨");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["VC_SIG_INVALID"] })).toBe("위조·변조");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["HOLDER_MISMATCH"] })).toBe("소유자 불일치");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["NONCE_REUSED"] })).toBe("재사용 차단");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["NONCE_EXPIRED"] })).toBe("요청 만료");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["SOMETHING_ELSE"] })).toBe("무효");
  });

  it("정지된 발급기관은 '미등록'이 아니라 '정지'로, 새 사유 코드도 각각의 상태로 (F32)", () => {
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["ISSUER_UNKNOWN"] })).toBe("발급기관 미등록");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["ISSUER_INACTIVE"] })).toBe("발급기관 정지");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["EXPIRED"] })).toBe("유효기간 만료");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["ISSUER_NOT_AUTHORITATIVE", "CLAIM_MISSING"] })).toBe("발급 권한 없음");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["STATUS_LIST_OWNER_MISMATCH"] })).toBe("상태 목록 불일치");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["RULE_VERSION_NOT_ACCEPTED"] })).toBe("규칙 버전 불일치");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["UNREQUESTED_CREDENTIAL"] })).toBe("요청 외 증명서 포함");
  });

  it("원장 장애(LEDGER_UNAVAILABLE)는 다른 사유보다 먼저 — '미등록·위조'로 보이지 않게", () => {
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["LEDGER_UNAVAILABLE"] })).toBe("원장 연결 실패");
    expect(statusLabel({ verdict: "FAIL", reasonCodes: ["CLAIM_MISSING", "LEDGER_UNAVAILABLE"] })).toBe("원장 연결 실패");
  });
});

describe("credentialValueLabel (F38)", () => {
  it("참·거짓은 그대로, 해석하지 못한 값(null·없음)은 '거짓'이 아니라 확인 안 함(중립)", () => {
    expect(credentialValueLabel(true)).toEqual({ text: "참", tone: "pass" });
    expect(credentialValueLabel(false)).toEqual({ text: "거짓", tone: "fail" });
    expect(credentialValueLabel(null)).toEqual({ text: "—(확인 안 함)", tone: "muted" });
    expect(credentialValueLabel(undefined)).toEqual({ text: "—(확인 안 함)", tone: "muted" });
  });
});

describe("attackOutcome (F28·F29)", () => {
  it("FAIL + 예상 사유 코드 포함일 때만 '차단됨'", () => {
    expect(attackOutcome({ verdict: "FAIL", reasonCodes: ["NONCE_REUSED"] }, "NONCE_REUSED")).toBe("blocked");
    expect(attackOutcome({ verdict: "FAIL", reasonCodes: ["HOLDER_MISMATCH", "VC_SIG_INVALID"] }, "VC_SIG_INVALID")).toBe("blocked");
  });

  it("FAIL 이지만 예상 코드가 없으면 다른 사유 — 만료 공격 뒤 재사용 카드가 NONCE_EXPIRED 로 막힌 경우", () => {
    expect(attackOutcome({ verdict: "FAIL", reasonCodes: ["NONCE_EXPIRED"] }, "NONCE_REUSED")).toBe("other-reason");
    expect(attackOutcome({ verdict: "FAIL", reasonCodes: ["CLAIM_MISSING"] }, "HOLDER_MISMATCH")).toBe("other-reason");
    expect(attackOutcome({ verdict: "FAIL", reasonCodes: [] }, "VC_SIG_INVALID")).toBe("other-reason");
  });

  it("PASS 는 사유 코드와 상관없이 차단되지 않음", () => {
    expect(attackOutcome({ verdict: "PASS", reasonCodes: [] }, "NONCE_REUSED")).toBe("not-blocked");
    expect(attackOutcome({ verdict: "PASS", reasonCodes: ["NONCE_REUSED"] }, "NONCE_REUSED")).toBe("not-blocked");
  });
});

describe("issuerNames / receivedFactCount", () => {
  it("발급기관 이름 중복 제거, 순서 유지", () => {
    expect(
      issuerNames({
        issuers: { daeguResident: "대구광역시", incomeBelow50Median: "대구광역시" },
        credentials: [{ issuerName: "iM뱅크" }, { issuerName: "대구광역시" }],
      }),
    ).toEqual(["대구광역시", "iM뱅크"]);
  });
  it("받은 참/거짓 항목 수", () => {
    expect(receivedFactCount({ claims: { a: true, b: true }, credentials: [] })).toBe(2);
    expect(receivedFactCount({ claims: {}, credentials: [{ claim: "a" }, { claim: null }] })).toBe(1);
  });
});

describe("factLabel", () => {
  it("'여부'를 떼고, 기대값 거짓이면 '아님'", () => {
    expect(factLabel("신용평점 하위 20% 여부", true)).toBe("신용평점 하위 20%");
    expect(factLabel("기초생활보장 급여 수급 여부", false)).toBe("기초생활보장 급여 수급 아님");
    expect(factLabel("creditBottom20", true)).toBe("creditBottom20");
  });

  it("서버가 보내는 번들 라벨의 '(창구 자체 조회)' 꼬리말도 뗀다", () => {
    expect(factLabel("신용평점 하위 20% 여부 (창구 자체 조회)", true)).toBe("신용평점 하위 20%");
  });
});

describe("policyCheckNotes", () => {
  it("판정 불가: 결과를 바꾸는 미제출 항목을 서버 라벨로 나열한다", () => {
    const n = policyCheckNotes({
      policyId: "near-poor",
      eligible: null,
      pending: [{ claim: "isBenefitRecipient", label: "기초생활보장 급여 수급 여부" }],
      counterChecked: [],
    });
    expect(n.pending).toBe("판정에 필요한 항목이 제출되지 않았습니다: 기초생활보장 급여 수급 여부");
    expect(n.counterChecked).toBeNull();
  });

  it("여러 항목은 ' · ' 로 잇고, 라벨이 비면 내장 라벨로", () => {
    const n = policyCheckNotes({
      policyId: "sunshine-loan-general",
      eligible: null,
      pending: [
        { claim: "annualIncomeUnder35M", label: "" },
        { claim: "annualIncomeUnder45M", label: "연소득 4,500만 원 이하 여부" },
      ],
    });
    expect(n.pending).toBe("판정에 필요한 항목이 제출되지 않았습니다: 연소득 3,500만 원 이하 여부 · 연소득 4,500만 원 이하 여부");
  });

  it("창구 조회 항목(counterCheck)은 '미제출'이 아니라 '창구 확인 필요'로 따로 적는다", () => {
    const n = policyCheckNotes({
      policyId: "sunshine-loan-general",
      eligible: null,
      pending: [
        { claim: "annualIncomeUnder35M", label: "연소득 3,500만 원 이하 여부", counterCheck: false },
        { claim: "creditBottom20", label: "신용평점 하위 20% 여부 (창구 자체 조회)", counterCheck: true },
      ],
    });
    expect(n.pending).toBe(
      "판정에 필요한 항목이 제출되지 않았습니다: 연소득 3,500만 원 이하 여부 / 창구 확인이 필요한 항목: 신용평점 하위 20%",
    );
  });

  it("창구 자체 확인 항목이 있으면 판정과 무관하게 표시한다", () => {
    const n = policyCheckNotes({
      policyId: "sunshine-loan-general",
      eligible: true,
      pending: [],
      counterChecked: [{ claim: "creditBottom20", expected: true, label: "신용평점 하위 20% 여부 (창구 자체 조회)" }],
    });
    expect(n.counterChecked).toBe("창구 자체 확인: 신용평점 하위 20%");
    expect(n.pending).toBeNull();
  });

  it("적격·부적격이면 pending 이 와도 판정 불가 문구를 내지 않는다", () => {
    for (const eligible of [true, false]) {
      const n = policyCheckNotes({ policyId: "new-hope-loan", eligible, pending: [{ claim: "creditBottom20", label: "x" }] });
      expect(n.pending).toBeNull();
    }
  });

  it("이전 서버 응답(pending·counterChecked 없음)은 보조 문구 없음", () => {
    expect(policyCheckNotes({ policyId: "unknown", eligible: null })).toEqual({ pending: null, counterChecked: null });
  });
});

describe("presetCounterCheckedNote", () => {
  const p = (id: string) => PRESETS_FALLBACK.find((x) => x.id === id);

  it("신용 하위 20% 프리셋에만 '창구가 먼저 확인' 문구", () => {
    expect(presetCounterCheckedNote(p("sunshine-general-low-credit"))).toBe("창구가 먼저 확인: 신용평점 하위 20%");
    expect(presetCounterCheckedNote(p("new-hope-low-credit"))).toBe("창구가 먼저 확인: 신용평점 하위 20%");
    for (const id of ["consult", "sunshine-general", "new-hope", "discount"]) expect(presetCounterCheckedNote(p(id))).toBeNull();
    expect(presetCounterCheckedNote(undefined)).toBeNull();
    expect(presetCounterCheckedNote(null)).toBeNull();
  });

  it("/claims 응답 라벨이 있으면 그것을 쓴다", () => {
    const labels = [{ claim: "creditBottom20", label: "신용평점 하위 20% 해당 여부" }];
    expect(presetCounterCheckedNote(p("new-hope-low-credit"), labels)).toBe("창구가 먼저 확인: 신용평점 하위 20% 해당");
  });
});
