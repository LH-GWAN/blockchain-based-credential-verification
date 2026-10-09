'use client';

import { receiptHash } from '@dbp/vc';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Collapsible, DetailTable, JsonView, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { COPY } from '@/lib/copy';
import { ENV } from '@/lib/env';
import { formatDateTime, prettyJson, shortDid, shortHash } from '@/lib/format';
import { readAnchoredAt } from '@/lib/ledger';
import { resolveLedgerAddresses } from '@/lib/ledgerAddresses';
import { getCachedBundle, getConsentReceipts, getPresentations } from '@/lib/store';
import type { Bundle, ConsentReceiptRecord, PresentationRecord, ReceiptData } from '@/lib/types';

type AnchorState = { status: 'checking' } | { status: 'anchored'; at: number } | { status: 'none' } | { status: 'error'; message: string };

/** 로컬 원문을 다시 해시해 저장된 해시와 대조 (§6.8). 원장 조회가 아니다 — 원장 기록은 '원장에서 확인' 으로 따로 본다 (F25). */
function localMatch(r: ReceiptData): boolean {
  try {
    return receiptHash(r.object).toLowerCase() === r.hash.toLowerCase();
  } catch {
    return false;
  }
}

/** 영수증 원문(JSON)을 항목–값 행으로. 해시 대조는 원문 그대로 하고, 화면에는 이름·시각·짧은 지문으로 보여 준다. */
function receiptRows(obj: Record<string, unknown>, names: Record<string, string>, labels: Record<string, string>): Array<[string, ReactNode]> {
  const F = COPY.history.fields;
  const order = ['kind', 'verifierDid', 'issuerDid', 'holderDid', 'claims', 'nonce', 'vpHash', 'ts', 'salt'];
  const keys = [...order.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !order.includes(k))];
  return keys.map((k) => {
    const v = obj[k];
    let node: ReactNode;
    switch (k) {
      case 'kind':
        node = COPY.history.kinds[String(v)] ?? String(v);
        break;
      case 'verifierDid':
      case 'issuerDid':
        node = names[String(v)] ?? String(v);
        break;
      case 'holderDid':
        node = <span className="font-mono text-[0.85rem]">{shortDid(String(v), 24)}</span>;
        break;
      case 'claims':
        node = Array.isArray(v) ? v.map((c) => labels[String(c)] ?? String(c)).join(', ') : String(v);
        break;
      case 'ts':
        node = typeof v === 'number' ? formatDateTime(v) : String(v);
        break;
      case 'nonce':
      case 'vpHash':
      case 'salt':
        node = <span className="font-mono text-[0.85rem]">{shortHash(String(v), 10, 6)}</span>;
        break;
      default:
        node = typeof v === 'string' ? v : prettyJson(v);
    }
    return [F[k] ?? k, node];
  });
}

function ReceiptLines({
  receipt,
  anchor,
  onCheck,
  names,
  labels,
}: {
  receipt: ReceiptData;
  anchor: AnchorState | undefined;
  /** 이 영수증 하나만 원장에서 조회 (F40 — 동의·제출 영수증을 한 번에 조회하지 않는다). */
  onCheck: () => void;
  /** DID → 기관 이름 (이 영수증의 상대 기관). */
  names: Record<string, string>;
  /** claim id → 한글 라벨 (동의 항목 표시용). */
  labels: Record<string, string>;
}) {
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
      {anchor && anchor.status === 'checking' && <p className="text-muted">{COPY.history.checking}</p>}
      {anchor && anchor.status === 'anchored' && <p className="font-semibold text-ok">{COPY.history.anchored(formatDateTime(anchor.at))}</p>}
      {anchor && anchor.status === 'none' && <p className="text-muted">{COPY.history.notAnchored}</p>}
      {anchor && anchor.status === 'error' && <p className="text-muted">{COPY.history.ledgerUnavailable}</p>}
      {(!anchor || anchor.status === 'none' || anchor.status === 'error') && (
        <Button variant="ghost" onClick={onCheck}>
          {COPY.history.checkLedger}
        </Button>
      )}
      <Collapsible summary={COPY.history.receiptTitle}>
        <DetailTable caption={COPY.history.receiptTitle} rows={receiptRows(receipt.object, names, labels)} />
        <Collapsible summary={COPY.history.rawToggle}>
          <JsonView value={receipt.object} label={COPY.history.rawToggle} />
        </Collapsible>
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
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    getCachedBundle()
      .then((b: Bundle | undefined) => b && setLabels(b.claims.labels))
      .catch(() => undefined);
  }, []);

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

  /**
   * 원장 ReceiptAnchor.anchoredAt(hash) — 누른 영수증 하나만 조회한다. 주소는 빌드 설정·단말 저장값을 먼저 쓰고,
   * 둘 다 없을 때만 발급기관에 배포 정보를 묻는다. 실패해도 화면은 유지.
   */
  async function checkAnchor(hash: string) {
    setAnchors((a) => ({ ...a, [hash]: { status: 'checking' } }));
    let st: AnchorState;
    try {
      const addresses = (await resolveLedgerAddresses({ fetchFromIssuer: false })) ?? (await resolveLedgerAddresses({ fetchFromIssuer: true }));
      if (!addresses?.ReceiptAnchor) throw new Error(COPY.history.ledgerUnavailable);
      const r = await readAnchoredAt(addresses, ENV.RPC_URL, hash);
      st = r.anchoredAt > 0 ? { status: 'anchored', at: r.anchoredAt } : { status: 'none' };
    } catch (e) {
      st = { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    setAnchors((a) => ({ ...a, [hash]: st }));
  }

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
      <SectionTitle sub={COPY.history.subtitle}>{COPY.history.title}</SectionTitle>
      <p className="text-[0.85rem] text-muted">{COPY.history.lookupNote}</p>

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
              <li key={r.claim}>· {labels[r.claim] ?? r.label ?? r.claim}</li>
            ))}
          </ul>
          {p.confirmCode && (
            <p className="mt-1 text-[0.85rem] text-muted">
              {COPY.present.confirmLabel} {p.confirmCode}
            </p>
          )}
          {p.verdict === 'FAIL' && p.reasons.length > 0 && <p className="mt-1 text-[0.9rem] text-danger">{p.reasons.join(' / ')}</p>}
          {p.receipt ? (
            <ReceiptLines
              receipt={p.receipt}
              anchor={anchors[p.receipt.hash]}
              onCheck={() => void checkAnchor(p.receipt!.hash)}
              names={{ [p.verifierDid]: p.verifierName }}
              labels={labels}
            />
          ) : (
            <p className="mt-2 text-[0.9rem] text-muted">영수증 없음</p>
          )}
        </Card>
      ))}

      <h2 className="text-[1rem] font-bold text-muted">{COPY.history.consents}</h2>
      {consents.length === 0 && <p className="text-[0.9rem] text-muted">{COPY.history.empty}</p>}
      {consents.map((c) => (
        <Card key={c.hash}>
          <p className="font-bold">{c.issuerName}</p>
          <p className="text-[0.85rem] text-muted">{formatDateTime(c.at)}</p>
          <p className="mt-1 text-[0.9rem]">동의 항목 {c.claims.length}개</p>
          <ReceiptLines receipt={c} anchor={anchors[c.hash]} onCheck={() => void checkAnchor(c.hash)} names={{ [c.issuerDid]: c.issuerName }} labels={labels} />
        </Card>
      ))}
    </div>
  );
}
