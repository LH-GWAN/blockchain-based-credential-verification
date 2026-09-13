"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { api, isApiError, isUnreachable } from "@/lib/api";
import { claimLabel, ERRORS, REQUEST } from "@/lib/copy";
import { formatCountdown, groupShortCode, remainingSeconds } from "@/lib/format";
import type { PresentationRequest } from "@/lib/types";

const URGENT_SEC = 20;
const POLL_MS = 1000;

type Props = {
  request: PresentationRequest;
  onRenew: () => void;
  onReset: () => void;
  renewing: boolean;
};

/** 화면 1 후반: QR + 6자리 코드 + 남은 시간. 1초마다 결과를 확인해 완료되면 결과 화면으로 이동한다. */
export function RequestQr({ request, onRenew, onReset, renewing }: Props) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pollState, setPollState] = useState<"ok" | "down" | "unknown">("ok");

  // QR 렌더링 (canvas)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    QRCode.toCanvas(el, request.qrText, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 420,
      color: { dark: "#1c1a2e", light: "#ffffff" },
    }).catch(() => {
      /* 렌더 실패 시 코드 입력으로 대체 */
    });
  }, [request.qrText]);

  // 남은 시간 틱
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // 결과 폴링
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api.getResult(request.requestId);
        if (!alive) return;
        setPollState("ok");
        if (r.status === "done") {
          router.push(`/result/${encodeURIComponent(request.requestId)}`);
          return;
        }
      } catch (e) {
        if (!alive) return;
        if (isApiError(e, 404)) {
          setPollState("unknown");
          return; // 서비스가 재시작됨 — 더 이상 폴링하지 않는다
        }
        if (isUnreachable(e)) setPollState("down");
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [request.requestId, router]);

  const remaining = remainingSeconds(request.exp, now);
  const expired = remaining <= 0;
  const urgent = !expired && remaining < URGENT_SEC;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="card flex flex-col items-center gap-4">
        <p className="kicker">1/3</p>
        <h1 className="text-2xl font-bold">{REQUEST.qrTitle}</h1>
        <div className={`rounded-2xl border-4 bg-white p-3 ${expired ? "border-fail opacity-40" : "border-accent"}`}>
          <canvas ref={canvasRef} width={420} height={420} className="block h-[420px] w-[420px] max-w-full" aria-label="검증 요청 QR" />
        </div>
        <p className="text-sm text-muted">
          QR 에는 요청 항목과 1회용 확인번호만 담깁니다. 시민 정보는 QR 에 없습니다.
        </p>
      </section>

      <section className="flex flex-col gap-6">
        <div className="card flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-bold">{REQUEST.codeTitle}</h2>
          <p
            className={`mono text-7xl font-bold tracking-[0.18em] sm:text-8xl ${expired ? "text-muted line-through" : "text-accent"}`}
            aria-label={`확인 코드 ${request.shortCode.split("").join(" ")}`}
          >
            {groupShortCode(request.shortCode)}
          </p>
          <div
            className={`mt-2 flex items-baseline gap-3 rounded-xl px-5 py-2 text-2xl font-semibold ${
              expired ? "bg-fail-soft text-fail" : urgent ? "bg-fail-soft text-fail" : "bg-accent-soft text-accent"
            }`}
            role="timer"
            aria-live="polite"
          >
            {expired ? (
              <span>{REQUEST.expired}</span>
            ) : (
              <>
                <span className="text-base font-medium">{REQUEST.remaining}</span>
                <span className="mono text-3xl tabular-nums">{formatCountdown(remaining)}</span>
              </>
            )}
          </div>
        </div>

        <div className="card flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="text-muted">{REQUEST.verifierLabel}</dt>
            <dd className="font-semibold">{request.verifierName}</dd>
            <dt className="text-muted">{REQUEST.purposeLabel}</dt>
            <dd className="font-semibold">{request.purpose}</dd>
            <dt className="text-muted">{REQUEST.requestId}</dt>
            <dd className="mono text-sm">{request.requestId}</dd>
          </dl>
          <h3 className="mt-2 text-lg font-bold">{REQUEST.requestedItems}</h3>
          <ul className="grid gap-1">
            {request.requested.map((r) => (
              <li key={r.claim} className="flex items-center gap-2 text-lg">
                <span className="font-bold text-pass" aria-hidden>
                  ✔
                </span>
                {claimLabel(r.claim, r.label)}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">{REQUEST.notRequested}</p>
        </div>

        <div className="card flex flex-wrap items-center gap-3">
          {expired ? (
            <>
              <p className="w-full font-medium text-fail">{REQUEST.expiredHint}</p>
              <button type="button" className="btn btn-primary" onClick={onRenew} disabled={renewing}>
                {renewing ? REQUEST.creating : REQUEST.newRequest}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onReset}>
                {REQUEST.changeSettings}
              </button>
            </>
          ) : pollState === "unknown" ? (
            <>
              <p className="w-full font-medium text-fail">
                {ERRORS.requestUnknown} — {ERRORS.requestUnknownHint}
              </p>
              <button type="button" className="btn btn-primary" onClick={onRenew} disabled={renewing}>
                {REQUEST.newRequest}
              </button>
            </>
          ) : (
            <>
              <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-accent" aria-hidden />
              <span className="text-lg text-muted" aria-live="polite">
                {pollState === "down" ? ERRORS.unavailable : REQUEST.waiting}
              </span>
              <span className="grow" />
              <button type="button" className="btn btn-ghost" onClick={onReset}>
                {REQUEST.changeSettings}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
