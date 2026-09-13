'use client';

import { receiptHash } from '@dbp/vc';
import { useEffect, useMemo, useState } from 'react';
import { Card, JsonView, Collapsible, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { issuerApi } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { ENV } from '@/lib/env';
import { formatDateTime, shortHash } from '@/lib/format';
import { readAnchoredAt } from '@/lib/ledger';
import { getConsentReceipts, getPresentations } from '@/lib/store';
import type { ConsentReceiptRecord, LedgerDeployment, PresentationRecord, ReceiptData } from '@/lib/types';

type AnchorState = { status: 'checking' } | { status: 'anchored'; at: number } | { status: 'none' } | { status: 'error'; message: string };

/** 로컬 원문을 다시 해시해 저장된 해시와 대조 (§6.8). */
function localMatch(r: ReceiptData): boolean {
  try {
    return receiptHash(r.object).toLowerCase() === r.hash.toLowerCase();
  } catch {
    return false;
  }
}

function ReceiptLines({ receipt, anchor }: { receipt: ReceiptData; anchor: AnchorState | undefined }) {
  const ok = localMatch(receipt);
  return (
    <div className="mt-2 space-y-1 text-[0.9rem]">
      <p className={ok ? 'font-semibold text-ok' : 'font-semibold text-danger'}>{ok ? COPY.history.matchOk : COPY.history.matchBad}</p>
      <p className="break-all">
        <span className="text-muted">{COPY.history.hash} </span>
        {shortHash(receipt.hash, 14, 8)}
      </p>
      <p className="break-all">
        <span className="text-muted">{COPY.history.tx} </span>
        {receipt.txHash ? shortHash(receipt.txHash, 14, 8) : COPY.history.noTx}
      </p>
      {anchor && anchor.status === 'checking' && <p className="text-muted">공동원장 확인 중…</p>}
      {anchor && anchor.status === 'anchored' && <p className="text-ok">{COPY.history.anchored(formatDateTime(anchor.at))}</p>}
      {anchor && anchor.status === 'none' && <p className="text-muted">{COPY.history.notAnchored}</p>}
      {anchor && anchor.status === 'error' && <p className="text-muted">{COPY.history.ledgerUnavailable}</p>}
      <Collapsible summary="영수증 원문 (내 휴대폰에만 보관)">
        <JsonView value={receipt.object} />
      </Collapsible>
    </div>
  );
}

export default function HistoryPage() {
  const { loading, wallet } = useWallet();
  const [consents, setConsents] = useState<ConsentReceiptRecord[]>([]);
  const [presentations, setPresentations] = useState<PresentationRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [anchors, setAnchors] = useState<Record<string, AnchorState>>({});
  const [ledgerNote, setLedgerNote] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    (async () => {
      try {
        const [c, p] = await Promise.all([getConsentReceipts(), getPresentations()]);
        setConsents(c.slice().reverse());
        setPresentations(p.slice().reverse());
      } finally {
        setReady(true);
      }
    })();
  }, [loading]);

  const hashes = useMemo(
    () => [...consents.map((c) => c.hash), ...presentations.map((p) => p.receipt?.hash).filter((h): h is string => !!h)],
    [consents, presentations],
  );

  // P1: 원장 ReceiptAnchor.anchoredAt(hash) — 실패해도 화면은 유지
  useEffect(() => {
    if (!ready || hashes.length === 0) return;
    let cancelled = false;
    (async () => {
      let deployment: LedgerDeployment;
      try {
        deployment = await issuerApi.ledgerDeployment(ENV.ISSUER_DAEGU_URL);
      } catch {
        if (!cancelled) setLedgerNote(COPY.history.ledgerUnavailable);
        return;
      }
      setAnchors(Object.fromEntries(hashes.map((h) => [h, { status: 'checking' as const }])));
      await Promise.all(
        hashes.map(async (h) => {
          let st: AnchorState;
          try {
            const r = await readAnchoredAt(deployment, ENV.RPC_URL, h);
            st = r.anchoredAt > 0 ? { status: 'anchored', at: r.anchoredAt } : { status: 'none' };
          } catch (e) {
            st = { status: 'error', message: e instanceof Error ? e.message : String(e) };
          }
          if (!cancelled) setAnchors((a) => ({ ...a, [h]: st }));
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, hashes]);

  if (loading || !ready) return <Spinner label={COPY.common.loading} />;
  if (!wallet) {
    return (
      <div className="space-y-3">
        <Notice kind="warn">{COPY.common.noWallet}</Notice>
        <LinkButton href="/" full>
          {COPY.common.goHome}
        </LinkButton>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionTitle sub="원장에는 솔트 포함 해시만 있고, 원문은 이 휴대폰에만 있습니다.">{COPY.history.title}</SectionTitle>
      {ledgerNote && <Notice kind="warn">{ledgerNote}</Notice>}

      <h2 className="text-[1rem] font-bold text-muted">{COPY.history.presentations}</h2>
      {presentations.length === 0 && <p className="text-[0.9rem] text-muted">{COPY.history.empty}</p>}
      {presentations.map((p) => (
        <Card key={p.requestId}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-bold">{p.verifierName}</p>
              <p className="text-[0.9rem] text-muted">{p.purpose}</p>
            </div>
            <span className={['shrink-0 rounded-full px-2 py-0.5 text-[0.8rem] font-semibold', p.verdict === 'PASS' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'].join(' ')}>
              {p.verdict === 'PASS' ? '✅ 충족' : '❌ 거부'}
            </span>
          </div>
          <p className="mt-1 text-[0.85rem] text-muted">
            {formatDateTime(p.at)}
            {p.totalMs !== null && ` · ${Math.round(p.totalMs)} ms`}
          </p>
          <ul className="mt-1 text-[0.9rem]">
            {p.requested.map((r) => (
              <li key={r.claim}>· {r.label ?? r.claim}</li>
            ))}
          </ul>
          {p.verdict === 'FAIL' && p.reasons.length > 0 && <p className="mt-1 text-[0.9rem] text-danger">{p.reasons.join(' / ')}</p>}
          {p.receipt ? <ReceiptLines receipt={p.receipt} anchor={anchors[p.receipt.hash]} /> : <p className="mt-2 text-[0.9rem] text-muted">영수증 없음</p>}
        </Card>
      ))}

      <h2 className="text-[1rem] font-bold text-muted">{COPY.history.consents}</h2>
      {consents.length === 0 && <p className="text-[0.9rem] text-muted">{COPY.history.empty}</p>}
      {consents.map((c) => (
        <Card key={c.hash}>
          <p className="font-bold">{c.issuerName}</p>
          <p className="text-[0.85rem] text-muted">{formatDateTime(c.at)}</p>
          <p className="mt-1 text-[0.9rem]">동의 항목 {c.claims.length}개</p>
          <ReceiptLines receipt={c} anchor={anchors[c.hash]} />
        </Card>
      ))}
    </div>
  );
}
