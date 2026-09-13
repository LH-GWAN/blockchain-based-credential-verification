/**
 * 요청 폼 상태 — 순수 리듀서. 프리셋 적용·항목 토글·용도 편집을 화면(RequestForm)과 분리해
 * vitest 로 검증한다 (test/request-state.test.ts).
 *
 * 규칙
 * - 프리셋을 누르면 용도·요청 항목·정책 ID 가 한 번에 채워지고 그 프리셋이 활성이 된다.
 * - 요청 항목을 직접 바꾸면 활성 프리셋과 정책 ID 가 해제된다 (정책 판정은 프리셋의 항목 조합을 전제로 한다).
 * - 용도 문구만 고치는 것은 프리셋을 해제하지 않는다.
 */
import { REQUEST } from "./copy";
import type { Preset } from "./types";

export const DEFAULT_PRESET_ID = "consult";

export type RequestedItem = { claim: string; expected: boolean };

export type RequestFormState = {
  purpose: string;
  requested: RequestedItem[];
  /** 활성 프리셋 ID. 항목을 직접 바꾸면 null. */
  presetId: string | null;
  /** 활성 프리셋이 정한 정책 ID. null 이면 POST /requests 에 policyId 를 보내지 않는다. */
  policyId: string | null;
};

export type RequestFormAction =
  | { type: "applyPreset"; preset: Preset }
  | { type: "toggleClaim"; claim: string }
  | { type: "setPurpose"; purpose: string }
  /** 서버 프리셋 도착: 활성 프리셋이 있으면 같은 ID 의 서버 사본으로 갱신한다(없으면 기본→첫 번째). */
  | { type: "presetsLoaded"; presets: readonly Preset[] };

function fromPreset(preset: Preset): RequestFormState {
  return {
    purpose: preset.purpose,
    requested: preset.requested.map((r) => ({ claim: r.claim, expected: r.expected })),
    presetId: preset.id,
    policyId: preset.policyId ?? null,
  };
}

/** 기본 프리셋(consult)이 있으면 그것으로, 없으면 첫 프리셋으로, 프리셋이 아예 없으면 빈 폼으로 시작한다. */
export function initialRequestState(presets: readonly Preset[], defaultId: string = DEFAULT_PRESET_ID): RequestFormState {
  const preset = presets.find((p) => p.id === defaultId) ?? presets[0];
  return preset ? fromPreset(preset) : { purpose: REQUEST.purposeDefault, requested: [], presetId: null, policyId: null };
}

export function isClaimSelected(state: RequestFormState, claim: string): boolean {
  return state.requested.some((r) => r.claim === claim);
}

export function requestFormReducer(state: RequestFormState, action: RequestFormAction): RequestFormState {
  switch (action.type) {
    case "applyPreset":
      return fromPreset(action.preset);
    case "toggleClaim": {
      const requested = isClaimSelected(state, action.claim)
        ? state.requested.filter((r) => r.claim !== action.claim)
        : [...state.requested, { claim: action.claim, expected: true }];
      return { ...state, requested, presetId: null, policyId: null };
    }
    case "setPurpose":
      return { ...state, purpose: action.purpose };
    case "presetsLoaded": {
      if (state.presetId === null) return state;
      const preset =
        action.presets.find((p) => p.id === state.presetId) ??
        action.presets.find((p) => p.id === DEFAULT_PRESET_ID) ??
        action.presets[0];
      return preset ? fromPreset(preset) : state;
    }
  }
}
