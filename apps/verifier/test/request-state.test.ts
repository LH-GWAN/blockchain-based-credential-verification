/**
 * 요청 폼 리듀서(순수 함수) 검증.
 * - 프리셋 적용: 용도·요청 항목·정책 ID 가 한 번에 채워진다.
 * - 항목을 직접 바꾸면 활성 프리셋·정책 ID 가 해제된다.
 * - 용도 문구 편집은 프리셋을 해제하지 않는다.
 * - 서버 프리셋 도착 시 같은 ID 의 서버 사본으로 갱신된다.
 */
import { describe, expect, it } from "vitest";
import { PRESETS_FALLBACK } from "../src/lib/copy";
import { DEFAULT_PRESET_ID, initialRequestState, isClaimSelected, requestFormReducer } from "../src/lib/request-state";
import type { Preset } from "../src/lib/types";

function preset(id: string): Preset {
  const p = PRESETS_FALLBACK.find((x) => x.id === id);
  if (!p) throw new Error(`프리셋 없음: ${id}`);
  return p;
}

const claimsOf = (s: { requested: { claim: string }[] }) => s.requested.map((r) => r.claim);

describe("initialRequestState", () => {
  it("기본 프리셋은 consult (대구 거주 + 중위소득 50%)", () => {
    const s = initialRequestState(PRESETS_FALLBACK);
    expect(DEFAULT_PRESET_ID).toBe("consult");
    expect(s.presetId).toBe("consult");
    expect(s.purpose).toBe("서민금융 상담 대상 확인");
    expect(claimsOf(s)).toEqual(["daeguResident", "incomeBelow50Median"]);
    expect(s.requested.every((r) => r.expected)).toBe(true);
    expect(s.policyId).toBeNull();
  });

  it("기본 ID 가 없으면 첫 프리셋, 프리셋이 없으면 빈 폼", () => {
    const withoutConsult = PRESETS_FALLBACK.filter((p) => p.id !== "consult");
    expect(initialRequestState(withoutConsult).presetId).toBe(withoutConsult[0]?.id);
    const empty = initialRequestState([]);
    expect(empty).toEqual({ purpose: "서민금융 상담 대상 확인", requested: [], presetId: null, policyId: null });
  });
});

describe("applyPreset", () => {
  it("용도·항목·정책 ID 를 한 번에 채운다", () => {
    const s = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-bank") });
    expect(s.presetId).toBe("sunshine-bank");
    expect(s.purpose).toBe("햇살론뱅크 대상 확인");
    expect(claimsOf(s)).toEqual(["annualIncomeUnder35M"]);
    expect(s.policyId).toBe("sunshine-loan-bank");
  });

  it("정책 ID 가 없는 프리셋은 policyId 를 null 로 되돌린다", () => {
    let s = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("new-hope") });
    expect(s.policyId).toBe("new-hope-loan");
    s = requestFormReducer(s, { type: "applyPreset", preset: preset("discount") });
    expect(s.policyId).toBeNull();
    expect(claimsOf(s)).toEqual(["incomeBelow50Median"]);
  });

  it("직접 편집한 뒤 다시 프리셋을 누르면 프리셋 상태로 복귀한다", () => {
    let s = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "toggleClaim", claim: "ageOver65" });
    expect(s.presetId).toBeNull();
    s = requestFormReducer(s, { type: "applyPreset", preset: preset("consult") });
    expect(s.presetId).toBe("consult");
    expect(claimsOf(s)).toEqual(["daeguResident", "incomeBelow50Median"]);
  });
});

describe("toggleClaim", () => {
  it("항목을 추가하면 활성 프리셋·정책 ID 가 해제된다", () => {
    const base = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-bank") });
    const s = requestFormReducer(base, { type: "toggleClaim", claim: "daeguResident" });
    expect(claimsOf(s)).toEqual(["annualIncomeUnder35M", "daeguResident"]);
    expect(s.requested.at(-1)).toEqual({ claim: "daeguResident", expected: true });
    expect(s.presetId).toBeNull();
    expect(s.policyId).toBeNull();
    expect(s.purpose).toBe("햇살론뱅크 대상 확인"); // 용도 문구는 유지
  });

  it("이미 있는 항목을 누르면 제거된다", () => {
    const base = initialRequestState(PRESETS_FALLBACK);
    const s = requestFormReducer(base, { type: "toggleClaim", claim: "daeguResident" });
    expect(claimsOf(s)).toEqual(["incomeBelow50Median"]);
    expect(isClaimSelected(s, "daeguResident")).toBe(false);
    expect(isClaimSelected(s, "incomeBelow50Median")).toBe(true);
    expect(s.presetId).toBeNull();
  });

  it("원래 상태를 변경하지 않는다", () => {
    const base = initialRequestState(PRESETS_FALLBACK);
    const snapshot = JSON.stringify(base);
    requestFormReducer(base, { type: "toggleClaim", claim: "ageOver65" });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("setPurpose", () => {
  it("용도 문구만 바뀌고 프리셋·정책 ID 는 유지된다", () => {
    const base = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-bank") });
    const s = requestFormReducer(base, { type: "setPurpose", purpose: "햇살론뱅크 대상 확인 (창구 상담)" });
    expect(s.purpose).toBe("햇살론뱅크 대상 확인 (창구 상담)");
    expect(s.presetId).toBe("sunshine-bank");
    expect(s.policyId).toBe("sunshine-loan-bank");
    expect(claimsOf(s)).toEqual(["annualIncomeUnder35M"]);
  });
});

describe("presetsLoaded", () => {
  const serverConsult: Preset = {
    ...preset("consult"),
    purpose: "서민금융 상담 대상 확인 (서버)",
    hint: "서버 힌트",
    requested: [{ claim: "daeguResident", expected: true }],
  };

  it("활성 프리셋이 있으면 같은 ID 의 서버 사본으로 갱신된다", () => {
    const s = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "presetsLoaded", presets: [serverConsult] });
    expect(s.presetId).toBe("consult");
    expect(s.purpose).toBe("서민금융 상담 대상 확인 (서버)");
    expect(claimsOf(s)).toEqual(["daeguResident"]);
  });

  it("직접 설정 중(프리셋 없음)이면 아무것도 바꾸지 않는다", () => {
    const custom = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "toggleClaim", claim: "ageOver65" });
    const s = requestFormReducer(custom, { type: "presetsLoaded", presets: [serverConsult] });
    expect(s).toBe(custom);
  });

  it("같은 ID 가 서버에 없으면 기본(consult) → 첫 프리셋 순으로 대체한다", () => {
    const sunshine = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-bank") });
    expect(requestFormReducer(sunshine, { type: "presetsLoaded", presets: [serverConsult] }).presetId).toBe("consult");
    const onlyDiscount = [preset("discount")];
    expect(requestFormReducer(sunshine, { type: "presetsLoaded", presets: onlyDiscount }).presetId).toBe("discount");
  });

  it("빈 목록이면 상태를 유지한다", () => {
    const base = initialRequestState(PRESETS_FALLBACK);
    expect(requestFormReducer(base, { type: "presetsLoaded", presets: [] })).toBe(base);
  });
});
