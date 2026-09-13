import { CHECK_LABELS, claimLabel, CRED_CHECK_LABELS, policyLabel, reasonText, RESULT, TIMING_LABELS } from "@/lib/copy";
import { formatDateTime, formatMs, formatSeconds, issuerNames, receivedFactCount, statusLabel } from "@/lib/format";
import { CHECK_KEYS, TIMING_PARTS, type VerificationResult } from "@/lib/types";
import { Checkmark } from "./Checkmark";
import { CopyButton } from "./CopyButton";

/* 결과 카드 조각들. ResultView(전체) 와 AttackPanel(축약) 이 조합해 쓴다. */

export function VerdictBanner({ result, compact = false }: { result: VerificationResult; compact?: boolean }) {
  const pass = result.verdict === "PASS";
  const issuers = issuerNames(result);
  return (
    <section
      className={`rounded-3xl border-2 ${compact ? "p-5" : "p-8"} ${pass ? "border-pass bg-pass-soft" : "border-fail bg-fail-soft"}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-6">
        <span className={compact ? "text-5xl" : "text-8xl"} aria-hidden>
          {pass ? "✅" : "❌"}
        </span>
        <div className="min-w-0">
          <h1 className={`${compact ? "text-3xl" : "text-6xl"} font-extrabold ${pass ? "text-pass" : "text-fail"}`}>
            {pass ? RESULT.pass : RESULT.fail}
          </h1>
          {!compact && (
            <p className="mt-2 text-xl">
              <span className="text-muted">{RESULT.issuer}: </span>
              <span className="font-semibold">{issuers.length ? issuers.join(" · ") : "—"}</span>
              <span className="text-muted"> · {RESULT.status}: </span>
              <span className="font-semibold">{statusLabel(result)}</span>
            </p>
          )}
          <p className={`${compact ? "text-base" : "text-lg"} text-muted`}>
            {result.verifier.name} · {result.purpose}
          </p>
        </div>
      </div>
    </section>
  );
}

export function ClaimsTable({ result }: { result: VerificationResult }) {
  return (
    <section className="card">
      <h2 className="text-xl font-bold">{RESULT.claimsTable}</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-lg">
          <thead>
            <tr className="border-b border-line text-sm text-muted uppercase">
              <th className="py-2 pr-4 font-semibold">{RESULT.colClaim}</th>
              <th className="py-2 pr-4 font-semibold">{RESULT.colResult}</th>
              <th className="py-2 font-semibold">{RESULT.colIssuer}</th>
            </tr>
          </thead>
          <tbody>
            {result.requested.map((r) => {
              const value = result.claims[r.claim];
              const presented = value !== undefined || result.credentials.some((c) => c.claim === r.claim);
              const ok = value !== undefined && value === r.expected;
              const issuer =
                result.issuers[r.claim] ?? result.credentials.find((c) => c.claim === r.claim)?.issuerName ?? "—";
              return (
                <tr key={r.claim} className="border-b border-line/60 last:border-0">
                  <td className="py-3 pr-4">
                    <div className="font-medium">{claimLabel(r.claim, r.label)}</div>
                    <div className="mono text-xs text-muted">{r.claim}</div>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="inline-flex items-center gap-2">
                      <Checkmark ok={presented ? ok : undefined} />
                      <span className={ok ? "text-pass" : presented ? "text-fail" : "text-muted"}>
                        {ok ? RESULT.yes : presented ? (value === undefined ? "검증 실패" : RESULT.no) : RESULT.notPresented}
                      </span>
                    </span>
                  </td>
                  <td className="py-3">{issuer}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ChecksList({ result, compact = false }: { result: VerificationResult; compact?: boolean }) {
  const list = (
    <ul className={`grid gap-2 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-2"}`}>
      {CHECK_KEYS.map((k) => (
        <li key={k} className={`flex items-center gap-3 rounded-xl border border-line bg-surface px-3 ${compact ? "min-h-10 py-1 text-base" : "min-h-12 py-2 text-lg"}`}>
          <Checkmark ok={result.checks[k]} />
          <span className="font-medium">{CHECK_LABELS[k]}</span>
          <span className="mono ml-auto text-xs text-muted">{k}</span>
        </li>
      ))}
    </ul>
  );
  if (compact) return list;
  return (
    <section className="card">
      <h2 className="text-xl font-bold">{RESULT.checklist}</h2>
      <p className="mb-3 text-sm text-muted">{RESULT.checklistHint}</p>
      {list}
    </section>
  );
}

const BAR_COLORS = ["#4c1d95", "#6d28d9", "#8b5cf6", "#a78bfa", "#c4b5fd"];

export function TimingPanel({ result, compact = false }: { result: VerificationResult; compact?: boolean }) {
  const t = result.timingsMs;
  const parts = TIMING_PARTS.map((p, i) => ({ key: p, label: TIMING_LABELS[p], ms: t[p] ?? 0, color: BAR_COLORS[i] ?? BAR_COLORS[0] }));
  const sum = parts.reduce((a, p) => a + p.ms, 0) || 1;
  const body = (
    <>
      <p className={`${compact ? "text-2xl" : "text-5xl"} font-extrabold text-accent`}>{RESULT.total(formatSeconds(t.total))}</p>
      <div className="mt-3 flex h-4 w-full overflow-hidden rounded-full bg-line" role="img" aria-label="단계별 소요 시간">
        {parts.map((p) => (
          <span
            key={p.key}
            style={{ width: `${Math.max(0.5, (p.ms / sum) * 100)}%`, background: p.color }}
            title={`${p.label} ${formatMs(p.ms)}`}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        {parts.map((p) => (
          <li key={p.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} aria-hidden />
            {p.label} <span className="mono">{formatMs(p.ms)}</span>
          </li>
        ))}
      </ul>
    </>
  );
  if (compact) return <div>{body}</div>;
  return (
    <section className="card">
      <h2 className="text-xl font-bold">{RESULT.timing}</h2>
      <div className="mt-2">{body}</div>
    </section>
  );
}

export function ReasonsPanel({ result, compact = false }: { result: VerificationResult; compact?: boolean }) {
  if (result.reasonCodes.length === 0) return null;
  const body = (
    <>
      <ul className={`grid gap-1 ${compact ? "text-base" : "text-lg"}`}>
        {result.reasonCodes.map((code, i) => (
          <li key={code} className="flex items-start gap-2">
            <span className="font-bold text-fail" aria-hidden>
              ✗
            </span>
            <span>{reasonText(code, result.reasons[i])}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex flex-wrap gap-1">
        <span className="text-xs text-muted">{RESULT.reasonCodes}:</span>
        {result.reasonCodes.map((c) => (
          <code key={c} className="mono rounded bg-fail-soft px-1.5 py-0.5 text-xs text-fail">
            {c}
          </code>
        ))}
      </p>
    </>
  );
  if (compact) return <div>{body}</div>;
  return (
    <section className="card border-fail/40">
      <h2 className="text-xl font-bold text-fail">{RESULT.reasons}</h2>
      <div className="mt-2">{body}</div>
    </section>
  );
}

export function ReceiptPanel({ result, txTimedOut }: { result: VerificationResult; txTimedOut: boolean }) {
  const r = result.receipt;
  const json = JSON.stringify({ hash: r.hash, txHash: r.txHash, object: r.object }, null, 2);
  return (
    <section className="card">
      <h2 className="text-xl font-bold">{RESULT.receipt}</h2>
      <dl className="mt-3 grid gap-3">
        <div>
          <dt className="text-sm text-muted">{RESULT.receiptHash}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code className="mono text-base">{r.hash}</code>
            <CopyButton text={r.hash} />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">{RESULT.receiptTx}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {r.txHash ? (
              <>
                <code className="mono text-base text-pass">{r.txHash}</code>
                <CopyButton text={r.txHash} />
              </>
            ) : txTimedOut || r.error ? (
              <span className="text-warn">{RESULT.receiptUnavailable}</span>
            ) : (
              <span className="inline-flex items-center gap-2 text-muted" aria-live="polite">
                <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-accent" aria-hidden />
                {RESULT.receiptRecording}
              </span>
            )}
          </dd>
        </div>
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer font-semibold text-accent">{RESULT.receiptObject}</summary>
        <pre className="mono mt-2 overflow-x-auto rounded-xl bg-surface-2 p-3 text-sm whitespace-pre-wrap">{json}</pre>
        <p className="mt-1 text-sm text-muted">{RESULT.receiptNote}</p>
      </details>
      <p className="mt-3 text-sm text-muted">
        {RESULT.verifiedAt}: {formatDateTime(result.verifiedAt)} · {RESULT.holder}: <code className="mono">{result.holderDidShort}</code>
      </p>
    </section>
  );
}

export function CredentialDetails({ result }: { result: VerificationResult }) {
  const labelOf = (claim: string | null | undefined) => {
    if (!claim) return "(항목 없음)";
    const req = result.requested.find((r) => r.claim === claim);
    return claimLabel(claim, req?.label);
  };
  return (
    <details className="card">
      <summary className="cursor-pointer text-xl font-bold">
        {RESULT.credentials} <span className="text-base font-normal text-muted">({result.credentials.length})</span>
      </summary>
      <ul className="mt-4 grid gap-4">
        {result.credentials.map((c, i) => (
          <li key={c.jti ?? i} className="rounded-xl border border-line bg-surface-2 p-4">
            {c.error ? (
              <p className="font-medium text-fail">{reasonText(c.error)}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-lg font-semibold">{labelOf(c.claim)}</p>
                  <span className={`badge ${c.value ? "text-pass" : "text-fail"}`}>
                    {RESULT.credValue}: {c.value ? RESULT.yes : RESULT.no}
                  </span>
                </div>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="text-muted">{RESULT.credIssuer}</dt>
                  <dd>
                    {c.issuerName ?? "—"} <code className="mono text-xs text-muted">{c.issuerDid}</code>
                  </dd>
                  <dt className="text-muted">{RESULT.credIndex}</dt>
                  <dd className="mono">
                    {c.statusListIndex ?? "—"}
                    {c.statusListVersion !== undefined && ` · ${RESULT.credListVersion} ${c.statusListVersion}`}
                  </dd>
                  <dt className="text-muted">{RESULT.credRule}</dt>
                  <dd className="mono">{c.ruleVersion ?? "—"}</dd>
                  <dt className="text-muted">{RESULT.credId}</dt>
                  <dd className="mono text-xs">{c.jti ?? "—"}</dd>
                </dl>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(c.checks ?? {}).map(([k, v]) => (
                    <li key={k} className="badge">
                      <Checkmark ok={v} />
                      {CRED_CHECK_LABELS[k] ?? k}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function DataNote({ result }: { result: VerificationResult }) {
  return (
    <p className="rounded-2xl border border-accent/30 bg-accent-soft px-5 py-4 text-lg font-medium text-accent">
      {RESULT.dataNote(receivedFactCount(result))}
    </p>
  );
}

/** policyId 를 보낸 요청에만 나오는 작은 카드: 제출된 참/거짓 항목만으로 정책 규칙을 다시 돌린 결과. */
export function PolicyCheckCard({ result }: { result: VerificationResult }) {
  const pc = result.policyCheck;
  if (!pc) return null;
  const verdict = pc.eligible === null ? RESULT.undetermined : pc.eligible ? RESULT.eligible : RESULT.ineligible;
  const tone =
    pc.eligible === null
      ? "border-warn/40 bg-warn-soft/50 text-warn"
      : pc.eligible
        ? "border-pass/40 bg-pass-soft text-pass"
        : "border-fail/40 bg-fail-soft text-fail";
  return (
    <section className={`rounded-2xl border px-5 py-4 ${tone}`} aria-label={RESULT.policyCheck}>
      <p className="text-lg">
        <span className="font-semibold">{RESULT.policyCheck}: </span>
        <span className="font-bold">{policyLabel(pc.policyId)}</span>
        <span> — </span>
        <span className="font-extrabold">{verdict}</span>
        <span className="text-sm"> ({RESULT.policyRuleNote})</span>
      </p>
      <p className="mono mt-1 text-xs opacity-80">{pc.policyId}</p>
    </section>
  );
}
