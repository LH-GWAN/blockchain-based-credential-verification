"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { STEPS } from "@/lib/copy";

/** §12.1 진행 단계 표시(1/3, 2/3, 3/3). 결과 단계는 requestId 가 있어야 하므로 링크가 없다. */
export function StepNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav aria-label="진행 단계" className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-6 py-3">
      {STEPS.map((step, i) => {
        const active = step.match(pathname);
        const cls = `inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-base font-semibold ${
          active ? "bg-accent text-white" : "bg-surface text-muted border border-line"
        }`;
        const inner = (
          <>
            <span className={`font-mono text-sm ${active ? "text-white/80" : "text-muted"}`}>
              {i + 1}/{STEPS.length}
            </span>
            {step.label}
          </>
        );
        return (
          <span key={step.label} className="flex items-center gap-2">
            {step.href ? (
              <Link href={step.href} className={cls} aria-current={active ? "step" : undefined}>
                {inner}
              </Link>
            ) : (
              <span className={cls} aria-current={active ? "step" : undefined}>
                {inner}
              </span>
            )}
            {i < STEPS.length - 1 && (
              <span className="text-line" aria-hidden>
                →
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
