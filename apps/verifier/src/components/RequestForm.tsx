"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { api, isApiError, isUnreachable } from "@/lib/api";
import { policyLabel, PRESETS_FALLBACK, REQUEST, requestErrorText, RULES_VERSION, verifierKindLabel } from "@/lib/copy";
import { saveCounterToken } from "@/lib/counter-token";
import { presetCounterCheckedNote } from "@/lib/format";
import { initialRequestState, isClaimSelected, presetsForKind, requestFormReducer } from "@/lib/request-state";
import type { ClaimDef, PresentationRequest, Preset, VerifierProfile } from "@/lib/types";
import { RequestQr } from "./RequestQr";
import { ServiceUnavailable } from "./ServiceUnavailable";

const DEFAULT_VERIFIER = "imbank-branch-01";

type Meta =
  | { kind: "loading" }
  | { kind: "down" }
  | { kind: "ready"; verifiers: VerifierProfile[]; claims: ClaimDef[]; presets: Preset[] };

/** 화면 1: 검증 요청 만들기 → QR/코드/남은 시간 → 결과 화면으로 자동 이동 */
export function RequestForm() {
  const [meta, setMeta] = useState<Meta>({ kind: "loading" });
  const [verifierId, setVerifierId] = useState(DEFAULT_VERIFIER);
  // 프리셋 목록이 도착하기 전에는 내장 사본으로 초기화한다 (기본: consult).
  const [form, dispatch] = useReducer(requestFormReducer, PRESETS_FALLBACK, initialRequestState);
  const [request, setRequest] = useState<PresentationRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    setMeta({ kind: "loading" });
    try {
      const [verifiers, claims, presets] = await Promise.all([
        api.verifiers(),
        api.claims(),
        // 프리셋은 부가 정보 — 서비스가 아직 /presets 를 모르거나 빈 목록이면 내장 사본을 쓴다.
        api
          .presets()
          .then((list) => (list.length > 0 ? list : [...PRESETS_FALLBACK]))
          .catch(() => [...PRESETS_FALLBACK]),
      ]);
      setMeta({ kind: "ready", verifiers, claims, presets });
      setVerifierId((cur) => (verifiers.some((v) => v.id === cur) ? cur : (verifiers[0]?.id ?? cur)));
      dispatch({ type: "presetsLoaded", presets });
    } catch {
      setMeta({ kind: "down" });
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // 창구 종류가 정해지거나 바뀌면, 그 창구가 취급하지 않는 활성 프리셋을 해제한다 (취급하면 그대로 — 리듀서가 같은 상태를 돌려준다).
  const verifierKind = meta.kind === "ready" ? meta.verifiers.find((v) => v.id === verifierId)?.kind : undefined;
  const presets = meta.kind === "ready" ? meta.presets : null;
  useEffect(() => {
    if (presets) dispatch({ type: "verifierChanged", kind: verifierKind, presets });
  }, [presets, verifierKind]);

  const create = useCallback(async () => {
    if (meta.kind !== "ready") return;
    const known = new Set(meta.claims.map((c) => c.claim));
    const requested = form.requested.filter((r) => known.has(r.claim));
    if (requested.length === 0) {
      setError(REQUEST.needOne);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const req = await api.createRequest({
        verifierId,
        purpose: form.purpose.trim() || REQUEST.purposeDefault,
        requested,
        ...(form.policyId ? { policyId: form.policyId } : {}),
        ...(form.presetId ? { presetId: form.presetId } : {}),
      });
      // 창구 토큰은 이 탭에만 보관한다 — 결과 조회(X-Counter-Token)에 필요하다 (F03).
      saveCounterToken(req.requestId, req.counterToken);
      setRequest(req);
    } catch (e) {
      if (isUnreachable(e)) setMeta({ kind: "down" });
      // 400 PRESET_NOT_OFFERED 등 아는 사유 코드는 한국어 문구로 보여 준다.
      else setError(requestErrorText(isApiError(e) ? e.code : String(e)));
    } finally {
      setSubmitting(false);
    }
  }, [meta, form, verifierId]);

  if (meta.kind === "loading") {
    return (
      <div className="card animate-pulse text-muted" aria-busy>
        불러오는 중…
      </div>
    );
  }
  if (meta.kind === "down") {
    return <ServiceUnavailable onRetry={loadMeta} />;
  }
  if (request) {
    return <RequestQr request={request} onRenew={create} onReset={() => setRequest(null)} renewing={submitting} />;
  }

  const activePreset = meta.presets.find((p) => p.id === form.presetId);
  // 이 창구가 취급하는 상품의 프리셋만 보인다 (예: 새희망홀씨는 은행 창구에만).
  const visiblePresets = presetsForKind(meta.presets, verifierKind);
  const selectedClaims = meta.claims.filter((c) => isClaimSelected(form, c.claim));
  // 신용 하위 20% 프리셋: 신용평점은 증명서로 받지 않는다 — 창구가 요청 전에 직접 조회해 두었어야 한다.
  const counterNote = presetCounterCheckedNote(activePreset, meta.claims);

  return (
    <form
      className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="card flex flex-col gap-6">
        <div>
          <p className="kicker">1/3</p>
          <h1 className="text-3xl font-bold">{REQUEST.title}</h1>
          <p className="mt-2 text-muted">{REQUEST.lead}</p>
        </div>

        <fieldset>
          <legend className="mb-2 text-lg font-semibold">{REQUEST.verifier}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {meta.verifiers.map((v) => {
              const active = v.id === verifierId;
              return (
                <label
                  key={v.id}
                  className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition ${
                    active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-accent/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="verifier"
                    value={v.id}
                    checked={active}
                    onChange={() => {
                      setVerifierId(v.id);
                      setError(null);
                    }}
                    className="h-5 w-5 accent-accent"
                  />
                  <span className="flex flex-col">
                    <span className="text-lg font-semibold">{v.name}</span>
                    <span className="text-sm text-muted">{verifierKindLabel(v.kind)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-lg font-semibold">{REQUEST.presets}</legend>
          <p className="mb-3 text-sm text-muted">{REQUEST.presetsLead}</p>
          <div className="flex flex-wrap gap-2">
            {visiblePresets.map((p) => {
              const active = p.id === form.presetId;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => dispatch({ type: "applyPreset", preset: p })}
                  className={`min-h-11 rounded-full border-2 px-4 text-base font-semibold transition focus-visible:ring-4 focus-visible:ring-accent-ring/40 focus-visible:outline-none ${
                    active ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink hover:border-accent/50"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted" aria-live="polite">
            <span>{activePreset ? activePreset.hint : REQUEST.presetCustom}</span>
            {activePreset?.policyId && (
              <span className="badge border-accent/30 bg-accent-soft text-accent">
                {REQUEST.presetPolicy}: {policyLabel(activePreset.policyId)}
              </span>
            )}
            {counterNote && <span className="badge border-warn/40 bg-warn-soft/50 text-warn">{counterNote}</span>}
          </p>
        </fieldset>

        <div>
          <label htmlFor="purpose" className="mb-2 block text-lg font-semibold">
            {REQUEST.purpose}
          </label>
          <input
            id="purpose"
            className="field"
            value={form.purpose}
            onChange={(e) => dispatch({ type: "setPurpose", purpose: e.target.value })}
            maxLength={80}
            autoComplete="off"
          />
        </div>

        <fieldset>
          <legend className="mb-1 text-lg font-semibold">{REQUEST.claims}</legend>
          <p className="mb-3 text-sm text-muted">{REQUEST.claimsHint}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {meta.claims.map((c) => {
              const on = isClaimSelected(form, c.claim);
              return (
                <li key={c.claim}>
                  <label
                    className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 transition ${
                      on ? "border-accent bg-accent-soft/60" : "border-line bg-surface hover:border-accent/50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => dispatch({ type: "toggleClaim", claim: c.claim })}
                      className="h-5 w-5 accent-accent"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{c.label}</span>
                      <span className="mono text-xs text-muted">{c.claim} · 기대값: 참</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        {error && (
          <p className="rounded-xl bg-fail-soft px-4 py-3 font-medium text-fail" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-xl" disabled={submitting}>
          {submitting ? REQUEST.creating : REQUEST.submit}
        </button>
      </div>

      <aside className="card flex flex-col gap-4 self-start bg-surface-2">
        <h2 className="text-xl font-bold">이 요청으로 창구가 받는 것</h2>
        <ul className="grid gap-2">
          {selectedClaims.map((c) => (
            <li key={c.claim} className="flex items-center gap-2 text-lg">
              <span className="font-bold text-pass" aria-hidden>
                ✔
              </span>
              {c.label}
            </li>
          ))}
          {selectedClaims.length === 0 && <li className="text-muted">{REQUEST.needOne}</li>}
        </ul>
        {form.policyId && (
          <p className="text-base">
            <span className="text-muted">{REQUEST.presetPolicy}: </span>
            <span className="font-semibold">{policyLabel(form.policyId)}</span>
            <span className="text-sm text-muted"> · 규칙 {RULES_VERSION} · 제출된 항목{counterNote ? "과 창구 확인값" : ""}만으로 계산</span>
          </p>
        )}
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-muted">{REQUEST.notRequested}</p>
        <p className="text-sm text-muted">
          각 항목은 발급기관이 서명한 참/거짓 하나뿐입니다. 창구는 발급기관 서버에 묻지 않고 공동원장에서 공개키·폐기
          상태·규칙 버전만 확인합니다.
        </p>
      </aside>
    </form>
  );
}
