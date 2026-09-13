import { VERIFIER_URL } from "@/lib/api";
import { ERRORS } from "@/lib/copy";

/** 검증 서비스에 닿지 못했을 때의 친절한 안내 */
export function ServiceUnavailable({ onRetry, busy }: { onRetry?: () => void; busy?: boolean }) {
  return (
    <div className="card border-warn/40 bg-warn-soft/40" role="alert">
      <div className="flex flex-wrap items-start gap-4">
        <span className="text-4xl" aria-hidden>
          ⚠️
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold text-ink">{ERRORS.unavailable}</h2>
          <p className="mt-2 text-muted">{ERRORS.unavailableHint(VERIFIER_URL)}</p>
        </div>
        {onRetry && (
          <button type="button" className="btn btn-secondary" onClick={onRetry} disabled={busy}>
            {ERRORS.retry}
          </button>
        )}
      </div>
    </div>
  );
}
