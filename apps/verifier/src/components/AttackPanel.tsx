"use client";

import Link from "next/link";
import { useState } from "react";
import { api, isApiError, isUnreachable } from "@/lib/api";
import { ATTACK, ERRORS } from "@/lib/copy";
import { ATTACK_KINDS, type AttackKind, type VerificationResult } from "@/lib/types";
import { ChecksList, ReasonsPanel, TimingPanel, VerdictBanner } from "./ResultParts";
import { ServiceUnavailable } from "./ServiceUnavailable";

type Cell = { kind: "idle" } | { kind: "running" } | { kind: "done"; result: VerificationResult } | { kind: "error"; code: string };

const ICONS: Record<AttackKind, string> = { replay: "🔁", expired: "⏰", forged: "✂️", "wrong-holder": "🎭" };

/** 화면 3: 공격 시연. 버튼 4개 → POST /demo/attack → 차단 결과를 축약 카드로 표시. */
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
            <section key={kind} className="card flex flex-col gap-4">
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
                <div className="flex flex-col gap-4 border-t border-line pt-4">
                  <VerdictBanner result={cell.result} compact />
                  <p
                    className={`rounded-xl px-4 py-2 text-lg font-semibold ${
                      cell.result.verdict === "FAIL" ? "bg-fail-soft text-fail" : "bg-warn-soft text-warn"
                    }`}
                  >
                    {cell.result.verdict === "FAIL" ? `⛔ ${ATTACK.blocked}` : ATTACK.notBlocked}
                    {cell.result.reasonCodes.includes(meta.expected) && (
                      <span className="ml-2 text-base font-normal">· {meta.expected} 확인</span>
                    )}
                  </p>
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
