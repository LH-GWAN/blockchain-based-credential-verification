"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, isApiError, isUnreachable } from "@/lib/api";
import { ERRORS, RESULT } from "@/lib/copy";
import { loadCounterToken } from "@/lib/counter-token";
import { formatCountdown, remainingSeconds } from "@/lib/format";
import type { VerificationResult } from "@/lib/types";
import {
  ChecksList,
  ClaimsTable,
  ComparisonPanel,
  CredentialDetails,
  DataNote,
  PolicyCheckCard,
  ReasonsPanel,
  ReceiptPanel,
  SubmissionCheck,
  TimingPanel,
  VerdictBanner,
} from "./ResultParts";
import { ServiceUnavailable } from "./ServiceUnavailable";

const POLL_MS = 1000;
const TX_WAIT_MS = 30_000;

type State =
  | { kind: "loading" }
  | { kind: "down" }
  | { kind: "unknown" }
  | { kind: "forbidden" }
  | { kind: "pending"; exp: number | null }
  | { kind: "done"; result: VerificationResult };

/** 라우트 파라미터가 인코딩된 채로 올 수 있다("rid%23replay-…"). 이미 풀려 있으면 그대로. */
function decodeParam(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/**
 * 화면 2: 결과. pending 이면 1초 폴링, done 이후에도 txHash 가 생길 때까지 최대 30초 폴링.
 * 결과 조회에는 요청을 만들 때 받은 창구 토큰이 필요하다(F03) — 없거나 다르면 '권한 없음'.
 */
export function ResultView({ requestId: rawId }: { requestId: string }) {
  const requestId = decodeParam(rawId);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [txTimedOut, setTxTimedOut] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const doneAt = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    const tick = async () => {
      try {
        const r = await api.getResult(requestId, loadCounterToken(requestId));
        if (!alive) return;
        if (r.status === "pending") {
          setState({ kind: "pending", exp: r.exp ?? null });
          schedule();
          return;
        }
        setState({ kind: "done", result: r });
        doneAt.current ??= Date.now();
        const needTx = !r.receipt?.txHash && !r.receipt?.error;
        if (!needTx) return;
        if (Date.now() - doneAt.current < TX_WAIT_MS) schedule();
        else setTxTimedOut(true);
      } catch (e) {
        if (!alive) return;
        if (isApiError(e, 404)) {
          setState({ kind: "unknown" });
          return;
        }
        if (isApiError(e, 401) || isApiError(e, 403)) {
          setState({ kind: "forbidden" });
          return;
        }
        if (isUnreachable(e)) setState((prev) => (prev.kind === "done" ? prev : { kind: "down" }));
        schedule();
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [requestId]);

  useEffect(() => {
    if (state.kind !== "pending") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.kind]);

  if (state.kind === "loading") {
    return (
      <div className="card animate-pulse text-muted" aria-busy>
        {RESULT.pending}
      </div>
    );
  }
  if (state.kind === "down") return <ServiceUnavailable />;
  if (state.kind === "unknown") {
    return (
      <div className="card" role="alert">
        <h1 className="text-2xl font-bold">{ERRORS.requestUnknown}</h1>
        <p className="mt-2 text-muted">{ERRORS.requestUnknownHint}</p>
        <Link href="/" className="btn btn-primary mt-4">
          {RESULT.newRequest}
        </Link>
      </div>
    );
  }
  if (state.kind === "forbidden") {
    return (
      <div className="card" role="alert">
        <h1 className="text-2xl font-bold">{ERRORS.resultForbidden}</h1>
        <p className="mt-2 text-muted">{ERRORS.resultForbiddenHint}</p>
        <Link href="/" className="btn btn-primary mt-4">
          {RESULT.newRequest}
        </Link>
      </div>
    );
  }
  if (state.kind === "pending") {
    const remaining = state.exp === null ? null : remainingSeconds(state.exp, now);
    const expired = remaining !== null && remaining <= 0;
    return (
      <div className="card flex flex-col items-start gap-3" aria-live="polite">
        <p className="kicker">2/3</p>
        <h1 className="text-3xl font-bold">{expired ? RESULT.pendingExpired : RESULT.pending}</h1>
        {!expired && (
          <>
            <p className="text-muted">{RESULT.pendingHint}</p>
            {remaining !== null && <p className="mono text-2xl text-accent">{formatCountdown(remaining)}</p>}
          </>
        )}
        <p className="mono text-sm text-muted">{requestId}</p>
        <Link href="/" className="btn btn-secondary">
          {RESULT.newRequest}
        </Link>
      </div>
    );
  }

  return <ResultDetails result={state.result} txTimedOut={txTimedOut} />;
}

/** 완료된 결과 화면 본문(상태 없음 — test/result-parts.test.tsx 가 렌더해 확인한다). */
export function ResultDetails({ result, txTimedOut }: { result: VerificationResult; txTimedOut: boolean }) {
  // 정책 판정·'실제로 받은 것' 비교는 PASS 일 때만 — FAIL 화면에 초록 '적격'·'받은 것 ✓'가 섞이지 않게 (F09).
  const pass = result.verdict === "PASS";
  return (
    <div className="flex flex-col gap-6">
      <p className="kicker">2/3 · 결과</p>
      <VerdictBanner result={result} />
      <SubmissionCheck result={result} />
      <DataNote result={result} />
      {pass && <PolicyCheckCard result={result} />}
      {pass && <ComparisonPanel result={result} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <ClaimsTable result={result} />
        <TimingPanel result={result} />
      </div>
      <ChecksList result={result} />
      <ReasonsPanel result={result} />
      <ReceiptPanel result={result} txTimedOut={txTimedOut} />
      <CredentialDetails result={result} />
      <div className="flex flex-wrap gap-3">
        <Link href="/" className="btn btn-primary btn-xl">
          {RESULT.newRequest}
        </Link>
        <Link href="/attack" className="btn btn-secondary btn-xl">
          {RESULT.toAttack}
        </Link>
      </div>
    </div>
  );
}
