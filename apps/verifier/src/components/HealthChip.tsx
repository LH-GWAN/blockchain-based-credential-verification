"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { HEALTH } from "@/lib/copy";
import type { Health } from "@/lib/types";

type State = { kind: "checking" } | { kind: "ok"; health: Health } | { kind: "down" };

/** 헤더의 서비스 상태 칩. GET /health 를 10초마다 확인한다. */
export function HealthChip() {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const health = await api.health();
        if (alive) setState(health.ok ? { kind: "ok", health } : { kind: "down" });
      } catch {
        if (alive) setState({ kind: "down" });
      }
      if (alive) timer = setTimeout(tick, 10_000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dot =
    state.kind === "ok" ? "bg-pass" : state.kind === "down" ? "bg-fail" : "bg-warn animate-pulse";
  const label = state.kind === "ok" ? HEALTH.ok : state.kind === "down" ? HEALTH.down : HEALTH.checking;

  return (
    <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
      <span className="badge">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
        {label}
      </span>
      {state.kind === "ok" && (
        <span className={`badge ${state.health.ledgerConnected ? "text-pass" : "text-warn"}`}>
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${state.health.ledgerConnected ? "bg-pass" : "bg-warn"}`}
            aria-hidden
          />
          {state.health.ledgerConnected ? HEALTH.ledgerOn : HEALTH.ledgerOff}
        </span>
      )}
    </div>
  );
}
