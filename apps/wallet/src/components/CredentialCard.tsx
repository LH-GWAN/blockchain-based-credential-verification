'use client';

import { decodeVc } from '@dbp/vc';
import { useMemo, useState } from 'react';
import { Button, Card, JsonView } from '@/components/ui';
import { COPY } from '@/lib/copy';
import { formatDate } from '@/lib/format';
import type { StoredCredential } from '@/lib/types';

/** 발급 완료 카드: 발급기관 · claim 문장 · 유효기간 · 상태. 원본 수치·이름은 어디에도 없다. */
export function CredentialCard({ credential }: { credential: StoredCredential }) {
  const [open, setOpen] = useState(false);
  const decoded = useMemo(() => {
    if (!open) return null;
    try {
      return decodeVc(credential.vcJwt).vc;
    } catch {
      return { error: '증명서를 해석하지 못했습니다' };
    }
  }, [open, credential.vcJwt]);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[0.85rem] font-semibold text-primary-dark">{credential.issuerName}</p>
          <p className="text-lg font-bold leading-snug">{credential.label}: 예</p>
        </div>
        <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-[0.8rem] font-semibold text-ok">{COPY.credentials.statusValid}</span>
      </div>
      <p className="mt-2 text-[0.9rem] text-muted">
        {COPY.credentials.validUntil} {formatDate(credential.validUntil)}
      </p>
      <div className="mt-2">
        <Button variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? COPY.credentials.hideDetails : COPY.credentials.details}
        </Button>
        {open && decoded && (
          <div className="mt-1">
            <p className="mb-1 text-[0.85rem] text-muted">증명서 내용 (사실 하나만 담깁니다 — 참/거짓)</p>
            <JsonView value={decoded} label="증명서 내용" />
          </div>
        )}
      </div>
    </Card>
  );
}

export function DeniedRow({ label }: { label: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-canvas px-4 py-3 text-muted">
      <p className="font-semibold line-through decoration-line">{label}</p>
      <p className="text-[0.85rem]">
        {COPY.credentials.deniedCardNote} · {COPY.credentials.deniedReason(label)}
      </p>
    </div>
  );
}
