'use client';

import { createVp } from '@dbp/vc';
import { useCallback, useEffect, useState } from 'react';
import { QrScanner } from '@/components/QrScanner';
import { Button, Card, KeyValue, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { verifierApi } from '@/lib/api';
import { confirmCodeOf, vpHashOf } from '@/lib/confirm';
import { COPY } from '@/lib/copy';
import { consentLabel, josa, selectVcsForRequest, type VcSelection } from '@/lib/eligibility';
import { ApiError, REASON_KO, toKoreanError } from '@/lib/errors';
import { shortHash } from '@/lib/format';
import { hexToBytes } from '@/lib/hex';
import { addPresentation, getCachedBundle, updatePresentation } from '@/lib/store';
import type { Bundle, PendingResult, PresentResult, PresentationRequest } from '@/lib/types';

type View = 'input' | 'loading' | 'confirm' | 'submitting' | 'awaiting' | 'result';

/** 보낸 제출물의 지문. 응답이 늦으면 이것으로 결과를 조회하고, 같은 요청으로 다시 제출하지 않는다 (F34). */
interface Submission {
  requestId: string;
  vpHash: string;
  confirmCode: string;
  /** 결과를 끝내 받지 못함 / 다른 제출이 먼저 기록됨. */
  outcome: 'waiting' | 'unknown' | 'other';
}

function isFinal(r: PresentResult | PendingResult): r is PresentResult {
  return 'verdict' in r && (r.verdict === 'PASS' || r.verdict === 'FAIL');
}

/** 연결이 끊긴 경우에만 QR 에 담긴 요청으로 대신 진행한다. 만료·사용됨(404)·조회 제한(429)은 그대로 알린다. */
function canUseQrFallback(e: unknown): boolean {
  return e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'TIMEOUT');
}

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
  const [submission, setSubmission] = useState<Submission | null>(null);
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
        if (fallback && isComplete(fallback) && canUseQrFallback(e)) req = fallback;
        else {
          setError(toKoreanError(e));
          setView('input');
          return;
        }
      }
      setRequest(req);
      setSelection(selectVcsForRequest(credentials, req.requested));
      setSubmission(null);
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
    if (!wallet || !request || !selection || submission) return;
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
      const sub: Submission = { requestId: request.requestId, vpHash: vpHashOf(vpJwt), confirmCode: confirmCodeOf(vpJwt), outcome: 'waiting' };
      let res: PresentResult;
      try {
        res = await verifierApi.present({ requestId: request.requestId, vpJwt });
      } catch (e) {
        // 응답 시간 초과: 제출이 이미 처리됐을 수 있으므로 다시 POST 하지 않고 내 제출물 해시로 결과를 조회한다 (F34)
        if (!(e instanceof ApiError && e.code === 'TIMEOUT')) throw e;
        setSubmission(sub);
        setView('awaiting');
        await waitForResult(sub);
        return;
      }
      await finish(res, sub);
    } catch (e) {
      setError(toKoreanError(e));
      setView('confirm');
    }
  }

  /** 시간 초과 뒤 결과 조회 (X-Vp-Hash). 결과가 오면 마무리하고, 끝내 없으면 확인 화면에 '결과 다시 확인' 을 남긴다. */
  async function waitForResult(sub: Submission) {
    setView('awaiting');
    for (let i = 0; i < 15; i++) {
      try {
        const r = await verifierApi.result(sub.requestId, sub.vpHash);
        if (isFinal(r)) {
          await finish(r, sub);
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) {
          setSubmission({ ...sub, outcome: 'other' });
          setView('confirm');
          return;
        }
        if (e instanceof ApiError && e.status === 404) break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setSubmission({ ...sub, outcome: 'unknown' });
    setView('confirm');
  }

  async function finish(res: PresentResult, sub: Submission) {
    if (!request) return;
    setSubmission({ ...sub, outcome: 'waiting' });
    setResult(res);
    setView('result');
    await addPresentation({
      requestId: request.requestId,
      verifierDid: request.verifier,
      verifierName: request.verifierName,
      purpose: request.purpose,
      // 이력에도 검증기관이 보낸 label 이 아니라 지갑이 아는 이름으로 남긴다 (F41)
      requested: request.requested.map((r) => ({
        ...r,
        label: consentLabel(r, labels, selection?.matched.find((m) => m.claim === r.claim)?.credential).label,
      })),
      verdict: res.verdict,
      reasonCodes: res.reasonCodes,
      reasons: res.reasons ?? res.reasonCodes.map((c) => REASON_KO[c] ?? c),
      receipt: res.receipt ? { hash: res.receipt.hash, object: res.receipt.object, txHash: res.receipt.txHash ?? null } : null,
      totalMs: res.timingsMs?.total ?? null,
      at: new Date().toISOString(),
      confirmCode: sub.confirmCode,
    });
    // 영수증 앵커는 비동기 → 몇 번 폴링해 txHash 를 가져온다
    if (res.receipt?.txHash) setTxStatus('found');
    else if (res.receipt?.hash) void pollTx(request.requestId, res.receipt.hash, sub.vpHash);
    else setTxStatus('unknown');
  }

  /** 영수증 앵커는 비동기이므로 결과를 몇 번 폴링한다. 조회 권한은 내 제출물 해시, 영수증 해시가 내 것일 때만 채택. */
  async function pollTx(requestId: string, myReceiptHash: string, vpHash: string) {
    setTxStatus('pending');
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await verifierApi.result(requestId, vpHash);
        if (!isFinal(r) || !r.receipt || r.receipt.hash !== myReceiptHash) continue;
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
    setSubmission(null);
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
        {submission && (
          <Card>
            <p className="text-[0.9rem] font-semibold text-muted">{COPY.present.confirmLabel}</p>
            <p data-testid="confirm-code" className="font-mono text-4xl font-bold tracking-[0.3em]" aria-label={`${COPY.present.confirmLabel} ${submission.confirmCode.split('').join(' ')}`}>
              {submission.confirmCode}
            </p>
            <p className="mt-1 text-[0.95rem]">{COPY.present.confirmCode(submission.confirmCode)}</p>
            {result.confirmCode !== undefined && result.confirmCode !== submission.confirmCode && (
              <Notice kind="error" className="mt-2">
                {COPY.present.confirmMismatch}
              </Notice>
            )}
            {(result.otherAttempts ?? 0) > 0 && <p className="mt-1 text-[0.85rem] text-muted">{COPY.present.otherAttempts(result.otherAttempts!)}</p>}
          </Card>
        )}
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
  if ((view === 'confirm' || view === 'submitting' || view === 'awaiting') && request && selection) {
    const remaining = request.exp - now;
    const expired = remaining <= 0;
    const canSubmit = selection.missing.length === 0 && !expired && view === 'confirm' && !submission;
    const items = request.requested.map((r) => {
      const m = selection.matched.find((x) => x.claim === r.claim);
      return { r, m, ...consentLabel(r, labels, m?.credential) };
    });
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
            {items.map(({ r, m, label }) => {
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
        {items
          .filter((it) => it.mismatch !== null)
          .map((it) => (
            <Notice key={`label-${it.r.claim}`} kind="warn">
              {COPY.present.labelMismatch(it.mismatch!, it.label)}
            </Notice>
          ))}
        {selection.missing.map((m) => (
          <Notice key={m.claim} kind="error">
            {COPY.present.missing(consentLabel(m, labels).label)}{' '}
            <LinkButton href="/credentials" variant="ghost">
              {COPY.present.goCredentials}
            </LinkButton>
          </Notice>
        ))}
        {expired && selection.missing.length === 0 && !submission && <Notice kind="warn">{COPY.present.expired}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {submission && submission.outcome !== 'waiting' && (
          <Notice kind="warn">
            {submission.outcome === 'other' ? COPY.present.otherSubmission : COPY.present.resultUnknown} ({COPY.present.confirmLabel} {submission.confirmCode})
          </Notice>
        )}
        {view === 'submitting' ? (
          <Spinner label={COPY.present.submitting} />
        ) : view === 'awaiting' ? (
          <Spinner label={COPY.present.awaiting} />
        ) : submission ? (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={resetAll}>
              {COPY.present.another}
            </Button>
            <Button onClick={() => void waitForResult(submission)} disabled={submission.outcome === 'other'}>
              {COPY.present.recheck}
            </Button>
          </div>
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
          className="w-full rounded-xl border border-line px-3 py-2 font-mono text-[0.85rem]"
        />
        <Button variant="secondary" full className="mt-2" onClick={submitPaste} disabled={pasted.trim().length === 0 || view === 'loading'}>
          {COPY.present.loadRequest}
        </Button>
      </Card>
    </div>
  );
}
