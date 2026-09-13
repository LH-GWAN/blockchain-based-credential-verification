'use client';

import { createVp } from '@dbp/vc';
import { useCallback, useEffect, useState } from 'react';
import { QrScanner } from '@/components/QrScanner';
import { Button, Card, KeyValue, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { verifierApi } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { josa, selectVcsForRequest, type VcSelection } from '@/lib/eligibility';
import { REASON_KO, toKoreanError } from '@/lib/errors';
import { shortHash } from '@/lib/format';
import { hexToBytes } from '@/lib/hex';
import { addPresentation, getCachedBundle, updatePresentation } from '@/lib/store';
import type { Bundle, PresentResult, PresentationRequest } from '@/lib/types';

type View = 'input' | 'loading' | 'confirm' | 'submitting' | 'result';

function parseQr(text: string): PresentationRequest | null {
  try {
    const obj = JSON.parse(text) as Partial<PresentationRequest>;
    if (obj && obj.type === 'dbp-presentation-request' && typeof obj.requestId === 'string') return obj as PresentationRequest;
  } catch {
    /* JSON 아님 */
  }
  return null;
}

function isComplete(r: Partial<PresentationRequest>): r is PresentationRequest {
  return typeof r.nonce === 'string' && typeof r.verifier === 'string' && Array.isArray(r.requested) && typeof r.exp === 'number';
}

export default function PresentPage() {
  const { loading, wallet, credentials } = useWallet();
  const [view, setView] = useState<View>('input');
  const [code, setCode] = useState('');
  const [pasted, setPasted] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<PresentationRequest | null>(null);
  const [selection, setSelection] = useState<VcSelection | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PresentResult | null>(null);
  const [txStatus, setTxStatus] = useState<'pending' | 'found' | 'unknown'>('pending');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    getCachedBundle()
      .then((b: Bundle | undefined) => b && setLabels(b.claims.labels))
      .catch(() => undefined);
  }, []);

  const loadRequest = useCallback(
    async (idOrCode: string, fallback?: PresentationRequest) => {
      setError(null);
      setView('loading');
      let req: PresentationRequest | null = null;
      try {
        req = await verifierApi.request(idOrCode);
      } catch (e) {
        if (fallback && isComplete(fallback)) req = fallback;
        else {
          setError(toKoreanError(e));
          setView('input');
          return;
        }
      }
      setRequest(req);
      setSelection(selectVcsForRequest(credentials, req.requested));
      setView('confirm');
    },
    [credentials],
  );

  const onScan = useCallback(
    (text: string) => {
      setScanning(false);
      const parsed = parseQr(text);
      if (parsed) void loadRequest(parsed.requestId, parsed);
      else if (/^\d{6}$/.test(text.trim())) void loadRequest(text.trim());
      else setError('QR 내용을 이해하지 못했습니다.');
    },
    [loadRequest],
  );

  function submitCode() {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) {
      setError('6자리 숫자를 입력해 주세요.');
      return;
    }
    void loadRequest(c);
  }

  function submitPaste() {
    const parsed = parseQr(pasted.trim());
    if (!parsed) {
      setError('붙여넣은 내용이 검증 요청 형식이 아닙니다.');
      return;
    }
    void loadRequest(parsed.requestId, parsed);
  }

  async function agree() {
    if (!wallet || !request || !selection) return;
    setView('submitting');
    setError(null);
    try {
      const vpJwt = createVp({
        holderDid: wallet.did,
        holderPrivateKey: hexToBytes(wallet.privateKey),
        verifierDid: request.verifier,
        nonce: request.nonce,
        vcJwts: selection.vcJwts,
      });
      const res = await verifierApi.present({ requestId: request.requestId, vpJwt });
      setResult(res);
      setView('result');
      await addPresentation({
        requestId: request.requestId,
        verifierDid: request.verifier,
        verifierName: request.verifierName,
        purpose: request.purpose,
        requested: request.requested,
        verdict: res.verdict,
        reasonCodes: res.reasonCodes,
        reasons: res.reasons ?? res.reasonCodes.map((c) => REASON_KO[c] ?? c),
        receipt: res.receipt ? { hash: res.receipt.hash, object: res.receipt.object, txHash: res.receipt.txHash ?? null } : null,
        totalMs: res.timingsMs?.total ?? null,
        at: new Date().toISOString(),
      });
      // 영수증 앵커는 비동기 → 몇 번 폴링해 txHash 를 가져온다
      if (res.receipt?.txHash) setTxStatus('found');
      else if (res.receipt?.hash) void pollTx(request.requestId, res.receipt.hash);
      else setTxStatus('unknown');
    } catch (e) {
      setError(toKoreanError(e));
      setView('confirm');
    }
  }

  /** 영수증 앵커는 비동기이므로 결과를 몇 번 폴링한다. 같은 요청에 다른 제출이 있을 수 있으므로 영수증 해시가 내 것일 때만 채택. */
  async function pollTx(requestId: string, myReceiptHash: string) {
    setTxStatus('pending');
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await verifierApi.result(requestId);
        if (r.status !== 'done' || !r.receipt || r.receipt.hash !== myReceiptHash) continue;
        if (r.receipt.txHash) {
          const txHash = r.receipt.txHash;
          setResult((cur) => (cur ? { ...cur, receipt: { ...cur.receipt, txHash } } : cur));
          await updatePresentation(requestId, { receipt: { hash: r.receipt.hash, object: r.receipt.object, txHash } });
          setTxStatus('found');
          return;
        }
        if (r.receipt.error) break;
      } catch {
        /* 다음 시도 */
      }
    }
    setTxStatus('unknown');
  }

  function resetAll() {
    setView('input');
    setRequest(null);
    setSelection(null);
    setResult(null);
    setError(null);
    setCode('');
    setPasted('');
  }

  if (loading) return <Spinner label={COPY.common.loading} />;
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

  // ---------- 결과 ----------
  if (view === 'result' && result) {
    const pass = result.verdict === 'PASS';
    return (
      <div className="space-y-4">
        <SectionTitle>{COPY.present.title}</SectionTitle>
        <Card className={pass ? 'border-ok bg-ok-soft' : 'border-danger bg-danger-soft'}>
          <p className="text-4xl" aria-hidden="true">
            {pass ? '✅' : '❌'}
          </p>
          <p className={['text-2xl font-bold', pass ? 'text-ok' : 'text-danger'].join(' ')}>{pass ? COPY.present.pass : COPY.present.fail}</p>
          {!pass && (
            <ul className="mt-2 space-y-1 text-[0.95rem] text-danger">
              {(result.reasons?.length ? result.reasons : result.reasonCodes.map((c) => REASON_KO[c] ?? c)).map((r, i) => (
                <li key={i}>· {r}</li>
              ))}
            </ul>
          )}
          {result.timingsMs?.total !== undefined && <p className="mt-2 text-[0.9rem] text-muted">{COPY.present.elapsed(Math.round(result.timingsMs.total))}</p>}
        </Card>
        <Card>
          <KeyValue
            items={[
              ['기관', result.verifier?.name ?? request?.verifierName ?? '—'],
              ['발급기관', Object.values(result.issuers ?? {}).filter((v, i, a) => a.indexOf(v) === i).join(', ') || '—'],
              [COPY.present.receiptLabel, shortHash(result.receipt?.hash)],
              [
                '원장 트랜잭션',
                result.receipt?.txHash
                  ? shortHash(result.receipt.txHash)
                  : result.receipt?.error || txStatus === 'unknown'
                    ? COPY.history.notAnchored
                    : COPY.present.txPending,
              ],
            ]}
          />
        </Card>
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={resetAll}>
            {COPY.present.another}
          </Button>
          <LinkButton href="/history">{COPY.present.viewHistory}</LinkButton>
        </div>
      </div>
    );
  }

  // ---------- 요청 확인 ----------
  if ((view === 'confirm' || view === 'submitting') && request && selection) {
    const remaining = request.exp - now;
    const expired = remaining <= 0;
    const canSubmit = selection.missing.length === 0 && !expired && view === 'confirm';
    return (
      <div className="space-y-4">
        <SectionTitle>{COPY.present.title}</SectionTitle>
        <Card>
          <h2 className="text-lg font-bold leading-snug">{COPY.present.requestTitle(josa(request.verifierName, '이/가'))}</h2>
          <p className="mt-1 text-[1rem]">
            {COPY.present.purpose}
            {request.purpose}
          </p>
          <ul className="mt-3 space-y-1 text-[1.05rem]">
            {request.requested.map((r) => {
              const m = selection.matched.find((x) => x.claim === r.claim);
              const label = r.label ?? labels[r.claim] ?? r.claim;
              return (
                <li key={r.claim} className="flex gap-2">
                  <span className={m ? 'text-ok' : 'text-danger'} aria-hidden="true">
                    {m ? '✔' : '✗'}
                  </span>
                  <span>
                    {label}
                    {r.expected === false && ' (아니오)'}
                    {m && <span className="ml-1 text-[0.9rem] text-muted">{COPY.present.issuedBy(m.credential.issuerName)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 rounded-xl bg-canvas px-3 py-2 text-[0.95rem] font-semibold text-muted">{COPY.present.notProvided}</p>
          <p className="mt-2 text-[0.85rem] text-muted">
            {COPY.present.nonceLabel} {shortHash(request.nonce, 8, 4)} · {expired ? COPY.present.expired : COPY.present.remaining(remaining)}
          </p>
        </Card>
        {selection.missing.map((m) => (
          <Notice key={m.claim} kind="error">
            {COPY.present.missing(m.label ?? labels[m.claim] ?? m.claim)}{' '}
            <LinkButton href="/credentials" variant="ghost">
              {COPY.present.goCredentials}
            </LinkButton>
          </Notice>
        ))}
        {expired && selection.missing.length === 0 && <Notice kind="warn">{COPY.present.expired}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {view === 'submitting' ? (
          <Spinner label={COPY.present.submitting} />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="danger" onClick={resetAll}>
              {COPY.present.deny}
            </Button>
            <Button onClick={agree} disabled={!canSubmit}>
              {COPY.present.agree}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // ---------- 입력 ----------
  return (
    <div className="space-y-4">
      <SectionTitle sub={COPY.present.codeHelp}>{COPY.present.title}</SectionTitle>
      {view === 'loading' && <Spinner label={COPY.common.loading} />}
      <Card>
        <label htmlFor="code" className="mb-1 block font-semibold">
          {COPY.present.codeLabel}
        </label>
        <input
          id="code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => e.key === 'Enter' && submitCode()}
          className="min-h-16 w-full rounded-xl border-2 border-line px-3 text-center font-mono text-3xl tracking-[0.4em]"
          placeholder="000000"
          aria-describedby="code-help"
        />
        <Button full className="mt-3" onClick={submitCode} disabled={code.length !== 6 || view === 'loading'}>
          {COPY.present.loadRequest}
        </Button>
      </Card>
      {error && <Notice kind="error">{error}</Notice>}
      {scanning ? (
        <QrScanner onResult={onScan} onClose={() => setScanning(false)} />
      ) : (
        <Button variant="secondary" full onClick={() => setScanning(true)}>
          {COPY.present.scanButton}
        </Button>
      )}
      <Card>
        <label htmlFor="paste" className="mb-1 block font-semibold">
          {COPY.present.pasteLabel}
        </label>
        <textarea
          id="paste"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={3}
          placeholder={COPY.present.pastePlaceholder}
          className="w-full rounded-xl border border-line px-3 py-2 font-mono text-[0.85rem]"
        />
        <Button variant="secondary" full className="mt-2" onClick={submitPaste} disabled={pasted.trim().length === 0 || view === 'loading'}>
          {COPY.present.loadRequest}
        </Button>
      </Card>
    </div>
  );
}
