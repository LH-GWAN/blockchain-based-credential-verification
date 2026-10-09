'use client';

import { decodeVc } from '@dbp/vc';
import { useMemo, useState } from 'react';
import { Button, Card, Collapsible, DetailTable, JsonView } from '@/components/ui';
import { COPY } from '@/lib/copy';
import type { CredentialStatus } from '@/lib/eligibility';
import { formatDate } from '@/lib/format';
import type { StoredCredential } from '@/lib/types';

const STATUS_VIEW: Record<CredentialStatus, { text: string; cls: string; note?: string }> = {
  checking: { text: COPY.credentials.statusChecking, cls: 'bg-canvas text-muted border border-line' },
  valid: { text: COPY.credentials.statusValid, cls: 'bg-ok-soft text-ok' },
  revoked: { text: COPY.credentials.statusRevoked, cls: 'bg-danger-soft text-danger', note: COPY.credentials.statusRevokedNote },
  expired: { text: COPY.credentials.statusExpired, cls: 'bg-danger-soft text-danger', note: COPY.credentials.statusExpiredNote },
  unknown: { text: COPY.credentials.statusUnknown, cls: 'bg-canvas text-muted border border-line', note: COPY.credentials.statusUnknownNote },
};

/**
 * 발급 완료 카드: 발급기관 · claim 문장 · 유효기간 · 상태. "자세히"는 표로 보여 주고, 원문 JSON 은 접힌 기술 정보 안에만 둔다. 원본 수치·이름은 어디에도 없다.
 * 상태는 유효기간과 공동원장 상태 목록의 폐기 비트로 정한다 (F30) — 원장을 읽지 못하면 '유효' 라고 하지 않는다.
 */
export function CredentialCard({ credential, status }: { credential: StoredCredential; status: CredentialStatus }) {
  const C = COPY.credentials;
  const st = STATUS_VIEW[status];
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
        <span className={['shrink-0 rounded-full px-2 py-0.5 text-[0.8rem] font-semibold', st.cls].join(' ')}>{st.text}</span>
      </div>
      {st.note && <p className={['mt-1 text-[0.85rem]', status === 'unknown' ? 'text-muted' : 'text-danger'].join(' ')}>{st.note}</p>}
      <p className="mt-2 text-[0.9rem] text-muted">
        {C.validUntil} {formatDate(credential.validUntil)}
      </p>
      <div className="mt-2">
        <Button variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? C.hideDetails : C.details}
        </Button>
        {open && (
          <div className="mt-2 space-y-2">
            <DetailTable
              caption={C.detailsCaption}
              rows={[
                [C.detailIssuer, credential.issuerName],
                [C.detailFact, `${credential.label}: ${credential.value ? C.factTrue : C.factFalse}`],
                [C.detailIssuedAt, formatDate(credential.issuedAt)],
                [C.detailValidUntil, formatDate(credential.validUntil)],
                [C.detailId, <span key="id" className="font-mono text-[0.85rem]">{credential.jti.replace(/^urn:uuid:/, '')}</span>],
              ]}
            />
            <p className="text-[0.85rem] text-muted">{C.notIncluded}</p>
            <Collapsible summary={C.rawToggle}>{decoded && <JsonView value={decoded} label={C.rawToggle} />}</Collapsible>
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
      <p className="text-[0.85rem]">{COPY.credentials.deniedCardNote}</p>
    </div>
  );
}
