"use client";

import Link from "next/link";
import { useState } from "react";
import { api, isApiError, isUnreachable } from "@/lib/api";
import { ATTACK, ERRORS } from "@/lib/copy";
import { attackOutcome, type AttackOutcome } from "@/lib/format";
import { ATTACK_KINDS, type AttackKind, type AttackResult } from "@/lib/types";
import { ChecksList, ReasonsPanel, TimingPanel, VerdictBanner } from "./ResultParts";
import { ServiceUnavailable } from "./ServiceUnavailable";

type Cell = { kind: "idle" } | { kind: "running" } | { kind: "done"; result: AttackResult } | { kind: "error"; code: string };

const ICONS: Record<AttackKind, string> = { replay: "🔁", expired: "⏰", forged: "✂️", "wrong-holder": "🎭" };

const OUTCOME_TONE: Record<AttackOutcome, string> = {
  blocked: "bg-fail-soft text-fail",
  "other-reason": "bg-warn-soft text-warn",
  "not-blocked": "bg-warn-soft text-warn",
};

/**
 * 화면 3: 공격 시연. 버튼 4개 → POST /demo/attack → 차단 결과를 축약 카드로 표시.
 * '차단됨'은 FAIL 이면서 그 공격의 예상 사유 코드가 있을 때만 표시한다 (F29). E2E 는 data-testid 로 카드·결과 블록을 집는다 (F26).
 */
export function AttackPanel() {
  const [cells, setCells] = useState<Record<AttackKind, Cell>>({
    replay: { kind: "idle" },
    expired: { kind: "idle" },
    forged: { kind: "idle" },
    "wrong-holder": { kind: "idle" },
  });
  const [needPrior, setNeedPrior] = useState(false);
  const [down, setDown] = useState(false);

  const run = async (kind: AttackKind) => {
    setCells((c) => ({ ...c, [kind]: { kind: "running" } }));
    setNeedPrior(false);
    setDown(false);
    try {
      const result = await api.attack(kind);
      setCells((c) => ({ ...c, [kind]: { kind: "done", result } }));
    } catch (e) {
      if (isApiError(e, 409)) {
        setNeedPrior(true);
        setCells((c) => ({ ...c, [kind]: { kind: "idle" } }));
      } else if (isUnreachable(e)) {
        setDown(true);
        setCells((c) => ({ ...c, [kind]: { kind: "idle" } }));
      } else {
        setCells((c) => ({ ...c, [kind]: { kind: "error", code: isApiError(e) ? e.code : String(e) } }));
      }
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="kicker">3/3</p>
        <h1 className="text-3xl font-bold">{ATTACK.title}</h1>
        <p className="mt-2 text-muted">{ATTACK.lead}</p>
      </div>

      {down && <ServiceUnavailable />}
      {needPrior && (
        <div className="card flex flex-wrap items-center gap-4 border-warn/40 bg-warn-soft/40" role="alert">
          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold">{ATTACK.needPrior}</p>
            <p className="text-muted">{ATTACK.needPriorHint}</p>
          </div>
          <Link href="/" className="btn btn-primary">
            {ATTACK.goHome}
          </Link>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {ATTACK_KINDS.map((kind) => {
          const meta = ATTACK.kinds[kind];
          const cell = cells[kind];
          const running = cell.kind === "running";
          return (
            <section key={kind} className="card flex flex-col gap-4" data-testid={`attack-card-${kind}`}>
              <button
                type="button"
                className={`btn btn-xl w-full justify-start gap-4 text-left ${cell.kind === "done" ? "btn-secondary" : "btn-primary"}`}
                onClick={() => void run(kind)}
                disabled={running}
                aria-busy={running}
              >
                <span className="text-3xl" aria-hidden>
                  {ICONS[kind]}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-2xl font-bold">{meta.label}</span>
                  <span className="text-base font-normal opacity-80">
                    {running ? ATTACK.running : cell.kind === "done" ? ATTACK.rerun : meta.what}
                  </span>
                </span>
              </button>
              <p className="text-base text-muted">
                {meta.explain}
                <span className="ml-2 badge">
                  {ATTACK.expectedCode}: <code className="mono">{meta.expected}</code>
                </span>
              </p>

              {cell.kind === "error" && (
                <p className="rounded-xl bg-fail-soft px-4 py-3 font-medium text-fail" role="alert">
                  {ERRORS.generic(cell.code)}
                </p>
              )}

              {cell.kind === "done" && (
                <div className="flex flex-col gap-4 border-t border-line pt-4" data-testid={`attack-result-${kind}`}>
                  <VerdictBanner result={cell.result} compact />
                  <AttackVerdict outcome={attackOutcome(cell.result, meta.expected)} expected={meta.expected} />
                  <ReasonsPanel result={cell.result} compact />
                  <TimingPanel result={cell.result} compact />
                  <details>
                    <summary className="cursor-pointer font-semibold text-accent">검증 단계 보기</summary>
                    <div className="mt-2">
                      <ChecksList result={cell.result} compact />
                    </div>
                  </details>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** 공격 결과 한 줄: 차단됨(+예상 코드 확인) · 다른 사유로 거부 · 차단되지 않음. */
export function AttackVerdict({ outcome, expected }: { outcome: AttackOutcome; expected: string }) {
  return (
    <p className={`rounded-xl px-4 py-2 text-lg font-semibold ${OUTCOME_TONE[outcome]}`} data-outcome={outcome}>
      {outcome === "blocked" ? (
        <>
          ⛔ {ATTACK.blocked}
          <span className="ml-2 text-base font-normal">{ATTACK.confirmed(expected)}</span>
        </>
      ) : outcome === "other-reason" ? (
        ATTACK.otherReason(expected)
      ) : (
        ATTACK.notBlocked
      )}
    </p>
  );
}
