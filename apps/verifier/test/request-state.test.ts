/**
 * 요청 폼 리듀서(순수 함수) 검증.
 * - 프리셋 적용: 용도·요청 항목·정책 ID 가 한 번에 채워진다.
 * - 항목을 직접 바꾸면 활성 프리셋·정책 ID 가 해제된다.
 * - 용도 문구 편집은 프리셋을 해제하지 않는다.
 * - 서버 프리셋 도착 시 같은 ID 의 서버 사본으로 갱신된다.
 * - 창구 종류별 프리셋 필터와, 창구를 바꿨을 때 활성 프리셋 유지/해제.
 */
import { describe, expect, it } from "vitest";
import { PRESETS_FALLBACK } from "../src/lib/copy";
import {
  DEFAULT_PRESET_ID,
  initialRequestState,
  isClaimSelected,
  isPresetOffered,
  presetsForKind,
  requestFormReducer,
} from "../src/lib/request-state";
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
    const s = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-general") });
    expect(s.presetId).toBe("sunshine-general");
    expect(s.purpose).toBe("햇살론 일반보증 대상 확인");
    expect(claimsOf(s)).toEqual(["annualIncomeUnder35M"]);
    expect(s.policyId).toBe("sunshine-loan-general");
  });

  it("새희망홀씨는 연소득 4,000만 원 이하 1개 항목 + new-hope-loan 판정", () => {
    const s = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("new-hope") });
    expect(s.presetId).toBe("new-hope");
    expect(s.purpose).toBe("새희망홀씨 대상 확인");
    expect(claimsOf(s)).toEqual(["annualIncomeUnder40M"]);
    expect(s.policyId).toBe("new-hope-loan");
  });

  it("신용 하위 20% 프리셋: 상위 소득 구간 1개 항목 + 같은 정책 판정 (신용평점은 요청 항목에 넣지 않는다)", () => {
    const base = initialRequestState(PRESETS_FALLBACK);
    const sunshine = requestFormReducer(base, { type: "applyPreset", preset: preset("sunshine-general-low-credit") });
    expect(sunshine.presetId).toBe("sunshine-general-low-credit");
    expect(sunshine.purpose).toBe("햇살론 일반보증 대상 확인 (신용평점 하위 20%)");
    expect(claimsOf(sunshine)).toEqual(["annualIncomeUnder45M"]);
    expect(sunshine.policyId).toBe("sunshine-loan-general");
    const newHope = requestFormReducer(base, { type: "applyPreset", preset: preset("new-hope-low-credit") });
    expect(newHope.presetId).toBe("new-hope-low-credit");
    expect(newHope.purpose).toBe("새희망홀씨 대상 확인 (신용평점 하위 20%)");
    expect(claimsOf(newHope)).toEqual(["annualIncomeUnder50M"]);
    expect(newHope.policyId).toBe("new-hope-loan");
    for (const s of [sunshine, newHope]) expect(isClaimSelected(s, "creditBottom20")).toBe(false);
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
    const base = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-general") });
    const s = requestFormReducer(base, { type: "toggleClaim", claim: "daeguResident" });
    expect(claimsOf(s)).toEqual(["annualIncomeUnder35M", "daeguResident"]);
    expect(s.requested.at(-1)).toEqual({ claim: "daeguResident", expected: true });
    expect(s.presetId).toBeNull();
    expect(s.policyId).toBeNull();
    expect(s.purpose).toBe("햇살론 일반보증 대상 확인"); // 용도 문구는 유지
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
    const base = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-general") });
    const s = requestFormReducer(base, { type: "setPurpose", purpose: "햇살론 일반보증 대상 확인 (창구 상담)" });
    expect(s.purpose).toBe("햇살론 일반보증 대상 확인 (창구 상담)");
    expect(s.presetId).toBe("sunshine-general");
    expect(s.policyId).toBe("sunshine-loan-general");
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
    const sunshine = requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset("sunshine-general") });
    expect(requestFormReducer(sunshine, { type: "presetsLoaded", presets: [serverConsult] }).presetId).toBe("consult");
    const onlyDiscount = [preset("discount")];
    expect(requestFormReducer(sunshine, { type: "presetsLoaded", presets: onlyDiscount }).presetId).toBe("discount");
  });

  it("빈 목록이면 상태를 유지한다", () => {
    const base = initialRequestState(PRESETS_FALLBACK);
    expect(requestFormReducer(base, { type: "presetsLoaded", presets: [] })).toBe(base);
  });
});

describe("presetsForKind · isPresetOffered", () => {
  const ids = (ps: readonly Preset[]) => ps.map((p) => p.id);

  it("은행 창구에는 여섯 가지 프리셋이 모두 보인다", () => {
    expect(ids(presetsForKind(PRESETS_FALLBACK, "bank"))).toEqual([
      "consult",
      "sunshine-general",
      "sunshine-general-low-credit",
      "new-hope",
      "new-hope-low-credit",
      "discount",
    ]);
  });

  it("저축은행 창구에는 새희망홀씨(신용 하위 20% 포함)가 없고 햇살론 일반보증은 둘 다 있다 (2026 개편)", () => {
    expect(ids(presetsForKind(PRESETS_FALLBACK, "savings"))).toEqual([
      "consult",
      "sunshine-general",
      "sunshine-general-low-credit",
      "discount",
    ]);
    expect(isPresetOffered(preset("new-hope"), "savings")).toBe(false);
    expect(isPresetOffered(preset("new-hope-low-credit"), "savings")).toBe(false);
    expect(isPresetOffered(preset("sunshine-general"), "savings")).toBe(true);
    expect(isPresetOffered(preset("sunshine-general-low-credit"), "savings")).toBe(true);
  });

  it("verifierKinds 가 없는 프리셋은 모든 창구에 보인다", () => {
    const legacy: Preset = { ...preset("consult"), id: "legacy", verifierKinds: undefined };
    expect(isPresetOffered(legacy, "savings")).toBe(true);
    expect(ids(presetsForKind([legacy, preset("new-hope")], "savings"))).toEqual(["legacy"]);
  });

  it("창구 종류를 모르면 거르지 않는다", () => {
    expect(ids(presetsForKind(PRESETS_FALLBACK, undefined))).toEqual(ids(PRESETS_FALLBACK));
    expect(ids(presetsForKind(PRESETS_FALLBACK, null))).toEqual(ids(PRESETS_FALLBACK));
  });

  it("모르는 창구 종류에는 verifierKinds 가 있는 프리셋이 보이지 않는다", () => {
    expect(presetsForKind(PRESETS_FALLBACK, "insurance")).toEqual([]);
  });

  it("원래 목록을 변경하지 않는다", () => {
    const list = [...PRESETS_FALLBACK];
    presetsForKind(list, "savings");
    expect(ids(list)).toEqual(ids(PRESETS_FALLBACK));
  });
});

describe("verifierChanged", () => {
  const at = (id: string) =>
    requestFormReducer(initialRequestState(PRESETS_FALLBACK), { type: "applyPreset", preset: preset(id) });

  it("시연 ③→③′: 햇살론 일반보증은 iM뱅크 → iM저축은행으로 바꿔도 그대로 유지된다", () => {
    const bank = at("sunshine-general");
    const s = requestFormReducer(bank, { type: "verifierChanged", kind: "savings", presets: PRESETS_FALLBACK });
    expect(s).toBe(bank);
    expect(s.presetId).toBe("sunshine-general");
    expect(s.policyId).toBe("sunshine-loan-general");
    expect(claimsOf(s)).toEqual(["annualIncomeUnder35M"]);
  });

  it("새희망홀씨는 저축은행 창구로 바꾸면 기본 프리셋(서민금융 상담)으로 바뀐다 — 용도와 항목이 함께", () => {
    const s = requestFormReducer(at("new-hope"), { type: "verifierChanged", kind: "savings", presets: PRESETS_FALLBACK });
    expect(s.presetId).toBe("consult");
    expect(s.policyId).toBeNull();
    expect(claimsOf(s)).toEqual(["daeguResident", "incomeBelow50Median"]);
    expect(s.purpose).toBe("서민금융 상담 대상 확인");
  });

  it("햇살론 일반보증 · 신용 하위 20% 도 저축은행 창구에서 그대로 유지된다", () => {
    const bank = at("sunshine-general-low-credit");
    const s = requestFormReducer(bank, { type: "verifierChanged", kind: "savings", presets: PRESETS_FALLBACK });
    expect(s).toBe(bank);
    expect(claimsOf(s)).toEqual(["annualIncomeUnder45M"]);
    expect(s.policyId).toBe("sunshine-loan-general");
  });

  it("새희망홀씨 · 신용 하위 20% 도 저축은행 창구로 바꾸면 기본 프리셋(서민금융 상담)으로 바뀐다", () => {
    const s = requestFormReducer(at("new-hope-low-credit"), { type: "verifierChanged", kind: "savings", presets: PRESETS_FALLBACK });
    expect(s.presetId).toBe("consult");
    expect(s.policyId).toBeNull();
    expect(claimsOf(s)).toEqual(["daeguResident", "incomeBelow50Median"]);
    expect(s.purpose).toBe("서민금융 상담 대상 확인");
    // 은행 창구로 돌아오면 그대로
    const s0 = at("new-hope-low-credit");
    expect(requestFormReducer(s0, { type: "verifierChanged", kind: "bank", presets: PRESETS_FALLBACK })).toBe(s0);
  });

  it("직접 고친 용도 문구는 해제되어도 유지된다", () => {
    const edited = requestFormReducer(at("new-hope"), { type: "setPurpose", purpose: "창구 상담 메모" });
    const s = requestFormReducer(edited, { type: "verifierChanged", kind: "savings", presets: PRESETS_FALLBACK });
    expect(s.presetId).toBeNull();
    expect(s.purpose).toBe("창구 상담 메모");
  });

  it("은행 창구로 바꾸면 새희망홀씨가 유지된다", () => {
    const s0 = at("new-hope");
    expect(requestFormReducer(s0, { type: "verifierChanged", kind: "bank", presets: PRESETS_FALLBACK })).toBe(s0);
  });

  it("직접 설정 중이거나 활성 프리셋을 목록에서 찾을 수 없으면 아무것도 바꾸지 않는다", () => {
    const custom = requestFormReducer(at("new-hope"), { type: "toggleClaim", claim: "daeguResident" });
    expect(requestFormReducer(custom, { type: "verifierChanged", kind: "savings", presets: PRESETS_FALLBACK })).toBe(custom);
    const s0 = at("new-hope");
    expect(requestFormReducer(s0, { type: "verifierChanged", kind: "savings", presets: [preset("consult")] })).toBe(s0);
  });

  it("창구 종류를 모르면 유지한다", () => {
    const s0 = at("new-hope");
    expect(requestFormReducer(s0, { type: "verifierChanged", kind: undefined, presets: PRESETS_FALLBACK })).toBe(s0);
  });

  it("해제 후 저축은행 화면에 보이는 프리셋을 다시 누르면 프리셋 상태로 복귀한다", () => {
    const cleared = requestFormReducer(at("new-hope"), { type: "verifierChanged", kind: "savings", presets: PRESETS_FALLBACK });
    const visible = presetsForKind(PRESETS_FALLBACK, "savings");
    const sunshine = visible.find((p) => p.id === "sunshine-general");
    if (!sunshine) throw new Error("저축은행 화면에 햇살론 일반보증 프리셋이 없음");
    const s = requestFormReducer(cleared, { type: "applyPreset", preset: sunshine });
    expect(s.presetId).toBe("sunshine-general");
    expect(s.policyId).toBe("sunshine-loan-general");
  });
});
