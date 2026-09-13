'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { prettyJson } from '@/lib/format';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-dark disabled:bg-line disabled:text-muted',
  secondary: 'bg-white text-primary-dark border-2 border-primary hover:bg-primary-soft disabled:border-line disabled:text-muted',
  danger: 'bg-white text-danger border-2 border-danger hover:bg-danger-soft disabled:border-line disabled:text-muted',
  ghost: 'bg-transparent text-primary-dark underline underline-offset-4 hover:bg-primary-soft',
};

const BASE = 'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-[1.05rem] font-bold transition-colors disabled:cursor-not-allowed';

export function Button({
  variant = 'primary',
  full = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; full?: boolean }) {
  return <button type="button" {...props} className={[BASE, VARIANT[variant], full ? 'w-full' : '', className].join(' ')} />;
}

export function LinkButton({
  href,
  variant = 'primary',
  full = false,
  children,
  className = '',
}: {
  href: string;
  variant?: Variant;
  full?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={[BASE, VARIANT[variant], full ? 'w-full' : '', 'no-underline', className].join(' ')}>
      {children}
    </Link>
  );
}

type NoticeKind = 'error' | 'info' | 'success' | 'warn';
const NOTICE: Record<NoticeKind, string> = {
  error: 'bg-danger-soft text-danger border-danger',
  info: 'bg-primary-soft text-primary-dark border-primary',
  success: 'bg-ok-soft text-ok border-ok',
  warn: 'bg-warn-soft text-warn border-warn',
};

export function Notice({ kind = 'info', children, className = '' }: { kind?: NoticeKind; children: ReactNode; className?: string }) {
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={['rounded-xl border-l-4 px-3 py-2 text-[0.95rem]', NOTICE[kind], className].join(' ')}>
      {children}
    </div>
  );
}

export function Card({ children, className = '', muted = false }: { children: ReactNode; className?: string; muted?: boolean }) {
  return (
    <section className={['rounded-2xl border border-line p-4', muted ? 'bg-canvas text-muted' : 'bg-surface', className].join(' ')}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-3">
      <h1 className="text-[1.35rem] font-bold leading-tight">{children}</h1>
      {sub && <p className="mt-1 text-[0.95rem] text-muted">{sub}</p>}
    </div>
  );
}

export function Collapsible({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 w-full items-center justify-between rounded-lg px-1 text-left font-semibold text-primary-dark hover:bg-primary-soft"
      >
        <span>{summary}</span>
        <span aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div id={id} className="mt-1 px-1">
          {children}
        </div>
      )}
    </div>
  );
}

export function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] w-full max-w-[430px] overflow-y-auto rounded-t-3xl bg-surface p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="닫기">
            닫기
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-4 text-muted">
      <span aria-hidden="true" className="inline-block h-6 w-6 animate-spin rounded-full border-4 border-line border-t-primary" />
      <span>{label}</span>
    </div>
  );
}

export function JsonView({ value, label }: { value: unknown; label?: string }) {
  return (
    <pre className="json overflow-x-auto rounded-xl bg-canvas p-3 text-ink" aria-label={label}>
      {typeof value === 'string' ? value : prettyJson(value)}
    </pre>
  );
}

export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.95rem]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="m-0 break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
