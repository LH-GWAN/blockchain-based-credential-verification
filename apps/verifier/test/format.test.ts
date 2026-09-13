import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatMs,
  formatSeconds,
  groupShortCode,
  issuerNames,
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
