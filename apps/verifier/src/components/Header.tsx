import Link from "next/link";
import { HEADER } from "@/lib/copy";
import { HealthChip } from "./HealthChip";
import { StepNav } from "./StepNav";

/** 모든 화면에 고정되는 헤더: 역할 선언 + 신뢰 배지 + 서비스 상태 + 진행 단계 */
export function Header() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="min-w-0">
          <Link href="/" className="flex items-center gap-3 no-underline">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-lg font-bold text-white"
              aria-hidden
            >
              검
            </span>
            <span className="flex flex-col">
              <span className="text-sm font-semibold text-muted">{HEADER.product}</span>
              <span className="text-xl font-bold text-ink">
                {HEADER.title}
                <span className="font-medium text-muted"> — {HEADER.subtitle}</span>
              </span>
            </span>
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge border-accent/30 bg-accent-soft text-accent">{HEADER.badgeLedger}</span>
          <span className="badge border-accent/30 bg-accent-soft text-accent">{HEADER.badgeRules}</span>
          <HealthChip />
        </div>
      </div>
      <div className="border-t border-line bg-surface-2">
        <StepNav />
      </div>
    </header>
  );
}
