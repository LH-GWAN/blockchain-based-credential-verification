'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { COPY } from '@/lib/copy';

const STEP_BY_PATH: Record<string, number> = { '/credentials': 0, '/benefits': 1, '/present': 2 };

const NAV = [
  { href: '/', label: COPY.nav.home },
  { href: '/credentials', label: COPY.nav.credentials },
  { href: '/benefits', label: COPY.nav.benefits },
  { href: '/present', label: COPY.nav.present },
  { href: '/history', label: COPY.nav.history },
] as const;

function StepIndicator({ current }: { current: number | undefined }) {
  return (
    <ol className="flex gap-1 text-[0.8rem] font-semibold" aria-label="진행 단계">
      {COPY.steps.map((label, i) => {
        const active = current === i;
        const done = current !== undefined && i < current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={[
              'flex-1 rounded-md px-1 py-1 text-center leading-tight',
              active ? 'bg-primary text-white' : done ? 'bg-primary-soft text-primary-dark' : 'bg-white text-muted border border-line',
            ].join(' ')}
          >
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function TrustBadges() {
  return (
    <ul className="flex flex-wrap justify-center gap-1 text-[0.72rem] text-muted" aria-label="신뢰 배지">
      {COPY.badges.map((b) => (
        <li key={b} className="rounded-full border border-line bg-white px-2 py-0.5 whitespace-nowrap">
          {b}
        </li>
      ))}
    </ul>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const step = STEP_BY_PATH[pathname];
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-surface shadow-[0_0_0_1px_var(--color-line)] sm:my-4 sm:min-h-[calc(100dvh-2rem)] sm:rounded-[2rem]">
      <header className="sticky top-0 z-10 space-y-2 border-b border-line bg-surface/95 px-4 pt-3 pb-2 backdrop-blur sm:rounded-t-[2rem]">
        <div className="flex items-baseline justify-between">
          <Link href="/" className="text-lg font-bold text-primary-dark no-underline">
            {COPY.appName}
          </Link>
          <span className="text-[0.75rem] text-muted">합성 데이터 시연</span>
        </div>
        <StepIndicator current={step} />
        <TrustBadges />
      </header>

      <main className="flex-1 px-4 pt-4 pb-24">{children}</main>

      <nav
        className="sticky bottom-0 z-10 grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur sm:rounded-b-[2rem]"
        aria-label="화면 이동"
      >
        {NAV.map((n) => {
          const active = pathname === n.href;
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex min-h-14 items-center justify-center text-[0.95rem] font-semibold no-underline',
                active ? 'text-primary-dark border-t-4 border-primary' : 'text-muted border-t-4 border-transparent',
              ].join(' ')}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
