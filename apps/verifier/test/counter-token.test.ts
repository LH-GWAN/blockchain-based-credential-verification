/**
 * F03 창구 토큰: 요청 ID 별로 sessionStorage 키 "dbp-counter-token:<requestId>" 에 보관하고,
 * "rid#replay-…" 같은 따로 기록된 제출은 원래 요청의 토큰을 쓴다. 저장소가 없거나 예외를 던져도 화면은 멈추지 않는다.
 */
import { describe, expect, it } from "vitest";
import { baseRequestId, COUNTER_TOKEN_PREFIX, counterTokenKey, loadCounterToken, saveCounterToken } from "../src/lib/counter-token";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("baseRequestId · counterTokenKey", () => {
  it("'#' 뒤(replay·rejected 꼬리)를 떼고 원래 요청 ID 로", () => {
    expect(baseRequestId("req-abc")).toBe("req-abc");
    expect(baseRequestId("req-abc#replay-1a2b3c")).toBe("req-abc");
    expect(baseRequestId("req-abc#rejected-ffffff")).toBe("req-abc");
  });

  it("키 형식은 dbp-counter-token:<requestId>", () => {
    expect(COUNTER_TOKEN_PREFIX).toBe("dbp-counter-token:");
    expect(counterTokenKey("req-abc")).toBe("dbp-counter-token:req-abc");
    expect(counterTokenKey("req-abc#replay-1a2b3c")).toBe("dbp-counter-token:req-abc");
  });
});

describe("saveCounterToken · loadCounterToken", () => {
  it("요청 ID 로 저장한 토큰을 같은 요청·따로 기록된 제출 키로 읽는다", () => {
    const store = memoryStore();
    saveCounterToken("req-abc", "a".repeat(32), store);
    expect(store.map.get("dbp-counter-token:req-abc")).toBe("a".repeat(32));
    expect(loadCounterToken("req-abc", store)).toBe("a".repeat(32));
    expect(loadCounterToken("req-abc#replay-1a2b3c", store)).toBe("a".repeat(32));
    expect(loadCounterToken("req-other", store)).toBeNull();
  });

  it("토큰이 없는 응답(이전 버전 서버)은 저장하지 않는다", () => {
    const store = memoryStore();
    saveCounterToken("req-abc", undefined, store);
    saveCounterToken("req-abc", "", store);
    expect(store.map.size).toBe(0);
  });

  it("저장소가 없거나(서버 렌더) 예외를 던져도(비공개 모드) 조용히 null", () => {
    expect(loadCounterToken("req-abc", null)).toBeNull();
    expect(() => saveCounterToken("req-abc", "t", null)).not.toThrow();
    expect(loadCounterToken("req-abc", throwing)).toBeNull();
    expect(() => saveCounterToken("req-abc", "t", throwing)).not.toThrow();
  });

  it("기본 저장소: window 가 없는 환경에서는 null", () => {
    expect(loadCounterToken("req-abc")).toBeNull();
  });
});
