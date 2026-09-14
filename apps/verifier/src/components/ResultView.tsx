"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, isApiError, isUnreachable } from "@/lib/api";
import { ERRORS, RESULT } from "@/lib/copy";
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
  | { kind: "pending"; exp: number }
  | { kind: "done"; result: VerificationResult };

/** 화면 2: 결과. pending 이면 1초 폴링, done 이후에도 txHash 가 생길 때까지 최대 30초 폴링. */
export function ResultView({ requestId }: { requestId: string }) {
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
        const r = await api.getResult(requestId);
        if (!alive) return;
        if (r.status === "pending") {
          setState({ kind: "pending", exp: r.exp });
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
  if (state.kind === "pending") {
    const remaining = remainingSeconds(state.exp, now);
    const expired = remaining <= 0;
    return (
      <div className="card flex flex-col items-start gap-3" aria-live="polite">
        <p className="kicker">2/3</p>
        <h1 className="text-3xl font-bold">{expired ? RESULT.pendingExpired : RESULT.pending}</h1>
        {!expired && (
          <>
            <p className="text-muted">{RESULT.pendingHint}</p>
            <p className="mono text-2xl text-accent">{formatCountdown(remaining)}</p>
          </>
        )}
        <p className="mono text-sm text-muted">{requestId}</p>
        <Link href="/" className="btn btn-secondary">
          {RESULT.newRequest}
        </Link>
      </div>
    );
  }

  const { result } = state;
  return (
    <div className="flex flex-col gap-6">
      <p className="kicker">2/3 · 결과</p>
      <VerdictBanner result={result} />
      <DataNote result={result} />
      <PolicyCheckCard result={result} />
      <ComparisonPanel result={result} />
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
