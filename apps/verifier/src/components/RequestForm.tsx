"use client";

import { useCallback, useEffect, useState } from "react";
import { api, isApiError, isUnreachable } from "@/lib/api";
import { ERRORS, REQUEST } from "@/lib/copy";
import type { ClaimDef, PresentationRequest, VerifierProfile } from "@/lib/types";
import { RequestQr } from "./RequestQr";
import { ServiceUnavailable } from "./ServiceUnavailable";

const DEFAULT_VERIFIER = "imbank-branch-01";
const DEFAULT_CLAIMS = ["daeguResident", "incomeBelow50Median"];

type Meta = { kind: "loading" } | { kind: "down" } | { kind: "ready"; verifiers: VerifierProfile[]; claims: ClaimDef[] };

/** 화면 1: 검증 요청 만들기 → QR/코드/남은 시간 → 결과 화면으로 자동 이동 */
export function RequestForm() {
  const [meta, setMeta] = useState<Meta>({ kind: "loading" });
  const [verifierId, setVerifierId] = useState(DEFAULT_VERIFIER);
  const [purpose, setPurpose] = useState<string>(REQUEST.purposeDefault);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(DEFAULT_CLAIMS));
  const [request, setRequest] = useState<PresentationRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    setMeta({ kind: "loading" });
    try {
      const [verifiers, claims] = await Promise.all([api.verifiers(), api.claims()]);
      setMeta({ kind: "ready", verifiers, claims });
      setVerifierId((cur) => (verifiers.some((v) => v.id === cur) ? cur : (verifiers[0]?.id ?? cur)));
    } catch {
      setMeta({ kind: "down" });
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const create = useCallback(async () => {
    if (meta.kind !== "ready") return;
    const requested = meta.claims.filter((c) => selected.has(c.claim)).map((c) => ({ claim: c.claim, expected: true }));
    if (requested.length === 0) {
      setError(REQUEST.needOne);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const req = await api.createRequest({ verifierId, purpose: purpose.trim() || REQUEST.purposeDefault, requested });
      setRequest(req);
    } catch (e) {
      if (isUnreachable(e)) setMeta({ kind: "down" });
      else setError(ERRORS.generic(isApiError(e) ? e.code : String(e)));
    } finally {
      setSubmitting(false);
    }
  }, [meta, selected, verifierId, purpose]);

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

  const toggle = (claim: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(claim)) next.delete(claim);
      else next.add(claim);
      return next;
    });

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
                    onChange={() => setVerifierId(v.id)}
                    className="h-5 w-5 accent-accent"
                  />
                  <span className="flex flex-col">
                    <span className="text-lg font-semibold">{v.name}</span>
                    <span className="text-sm text-muted">{v.kind === "bank" ? "금융기관" : "행정기관"}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label htmlFor="purpose" className="mb-2 block text-lg font-semibold">
            {REQUEST.purpose}
          </label>
          <input
            id="purpose"
            className="field"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            maxLength={80}
            autoComplete="off"
          />
        </div>

        <fieldset>
          <legend className="mb-1 text-lg font-semibold">{REQUEST.claims}</legend>
          <p className="mb-3 text-sm text-muted">{REQUEST.claimsHint}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {meta.claims.map((c) => {
              const on = selected.has(c.claim);
              return (
                <li key={c.claim}>
                  <label
                    className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 transition ${
                      on ? "border-accent bg-accent-soft/60" : "border-line bg-surface hover:border-accent/50"
                    }`}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggle(c.claim)} className="h-5 w-5 accent-accent" />
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
        <h2 className="text-xl font-bold">이 요청으로 기관이 받는 것</h2>
        <ul className="grid gap-2">
          {meta.claims
            .filter((c) => selected.has(c.claim))
            .map((c) => (
              <li key={c.claim} className="flex items-center gap-2 text-lg">
                <span className="font-bold text-pass" aria-hidden>
                  ✔
                </span>
                {c.label}
              </li>
            ))}
          {selected.size === 0 && <li className="text-muted">{REQUEST.needOne}</li>}
        </ul>
        <p className="rounded-xl border border-line bg-surface px-4 py-3 text-muted">{REQUEST.notRequested}</p>
        <p className="text-sm text-muted">
          각 항목은 발급기관이 서명한 참/거짓 하나뿐입니다. 검증기관은 발급기관 서버에 묻지 않고 공동원장에서 공개키·폐기
          상태·규칙 버전만 확인합니다.
        </p>
      </aside>
    </form>
  );
}
