'use client';

import { decodeVc, signJws } from '@dbp/vc';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CredentialCard, DeniedRow } from '@/components/CredentialCard';
import { Button, Card, DataTable, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { issuerApi } from '@/lib/api';
import { COPY } from '@/lib/copy';
import {
  checkBundleHash,
  computeClaims,
  credentialStatusOf,
  planByIssuer,
  selfCheckedClaims,
  statusRefOf,
  type ClaimDecision,
  type HashCheck,
  type IssuerPlan,
} from '@/lib/eligibility';
import { ENV, EVAL_DATE, ISSUERS, validEvalDate } from '@/lib/env';
import { toKoreanError } from '@/lib/errors';
import { hexToBytes } from '@/lib/hex';
import { readBundleOnLedger, readStatusList, revokedIn, type LedgerAddresses, type LedgerBundle } from '@/lib/ledger';
import { resolveLedgerAddresses } from '@/lib/ledgerAddresses';
import { addConsentReceipt, addCredentials, getCachedBundle, getCachedEvalDate, setCachedBundle, setCachedEvalDate } from '@/lib/store';
import type { Bundle, ClaimMap, IssuerWellKnown, StoredCredential, WalletRecord } from '@/lib/types';

type Phase = 'loading' | 'error' | 'precheck' | 'consent' | 'issuing' | 'cards';

interface Loaded {
  bundle: Bundle;
  fromCache: boolean;
  wellKnown: Record<string, IssuerWellKnown | undefined>;
  wellKnownErrors: Record<string, string>;
  hash: HashCheck;
  claims: ClaimMap;
  /** 발급기관별 계획 (issuerOf 순서: 대구광역시 → 사회보장정보원). 'self' 항목은 어디에도 없다. */
  plans: IssuerPlan[];
  /** 창구가 직접 확인하는 항목 (증명서 불필요) — 사전 판정 화면에만 표시. */
  selfChecked: ClaimDecision[];
  /** 사전 판정 기준일 — 발급기관이 알린 bundle.evalDate (F65). */
  evalDate: string;
  /** 공동원장 컨트랙트 주소 (없으면 원장 확인 불가). */
  addresses: LedgerAddresses | null;
}

/** 규칙 해시 대조 결과 → 한 줄 표시 (F19·F31). */
const HASH_LINE: Record<HashCheck['status'], { text: string; cls: string }> = {
  ledger: { text: COPY.credentials.hashLedger, cls: 'text-ok' },
  declared: { text: COPY.credentials.hashDeclared, cls: 'text-ok' },
  mismatch: { text: COPY.credentials.hashBad, cls: 'text-danger' },
  unregistered: { text: COPY.credentials.hashUnregistered, cls: 'text-danger' },
  unverified: { text: COPY.credentials.hashUnverified, cls: 'text-muted' },
};

export default function CredentialsPage() {
  const { loading, wallet, profile, credentials, reload } = useWallet();
  const [phase, setPhase] = useState<Phase>('loading');
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issuerIdx, setIssuerIdx] = useState(0);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuedNow, setIssuedNow] = useState<string[]>([]);
  /** jti → 원장 상태 목록의 폐기 비트 (null = 원장 확인 불가, 없음 = 확인 중). */
  const [revoked, setRevoked] = useState<Record<string, boolean | null>>({});

  const load = useCallback(async () => {
    if (!profile) return;
    setPhase('loading');
    setLoadError(null);
    const [bundleRes, addrRes, ...wkRes] = await Promise.allSettled([
      issuerApi.bundle(ENV.ISSUER_DAEGU_URL),
      resolveLedgerAddresses({ fetchFromIssuer: true }),
      ...ISSUERS.map((i) => issuerApi.wellKnown(i.url)),
    ]);
    let bundle: Bundle | undefined;
    let fromCache = false;
    if (bundleRes.status === 'fulfilled') {
      bundle = bundleRes.value;
      try {
        await setCachedBundle(bundle);
      } catch {
        /* 캐시 실패는 무시 */
      }
    } else {
      bundle = await getCachedBundle().catch(() => undefined);
      fromCache = bundle !== undefined;
      if (!bundle) {
        setLoadError(toKoreanError(bundleRes.reason));
        setPhase('error');
        return;
      }
    }
    const wellKnown: Loaded['wellKnown'] = {};
    const wellKnownErrors: Loaded['wellKnownErrors'] = {};
    ISSUERS.forEach((iss, i) => {
      const r = wkRes[i];
      if (r && r.status === 'fulfilled') wellKnown[iss.did] = r.value;
      else if (r) wellKnownErrors[iss.did] = toKoreanError(r.reason);
    });
    // 로컬 계산 해시를 공동원장 RuleRegistry 등록값(지갑이 직접 읽음)과, 발급기관이 알린 해시(대구광역시 우선)와 대조
    const addresses = addrRes.status === 'fulfilled' ? addrRes.value : null;
    let onLedger: LedgerBundle | undefined;
    if (addresses?.RuleRegistry) {
      try {
        onLedger = await readBundleOnLedger(addresses, ENV.RPC_URL, bundle.bundle, bundle.version);
      } catch {
        onLedger = undefined; // 원장 연결 실패 — 발급기관 선언값으로만 대조
      }
    }
    const declared = ISSUERS.map((i) => wellKnown[i.did]?.bundle.bundleHash).find((h): h is string => typeof h === 'string') ?? null;
    const hash = checkBundleHash(bundle, declared, onLedger);
    // 판정 기준일: 발급기관이 알린 날짜 → 지난번에 받아 둔 날짜 → 기본값 (발급기관 판정과 같은 날짜로 계산)
    const announced = ISSUERS.map((i) => validEvalDate(wellKnown[i.did]?.bundle.evalDate)).find((d): d is string => d !== null) ?? null;
    if (announced) setCachedEvalDate(announced).catch(() => undefined);
    const evalDate = announced ?? validEvalDate(await getCachedEvalDate().catch(() => undefined)) ?? EVAL_DATE;
    try {
      const claims = computeClaims(bundle, profile, evalDate);
      const plans = planByIssuer(bundle, claims);
      const selfChecked = selfCheckedClaims(bundle, claims);
      setData({ bundle, fromCache, wellKnown, wellKnownErrors, hash, claims, plans, selfChecked, evalDate, addresses });
      setPhase(credentials.length > 0 ? 'cards' : 'precheck');
    } catch (e) {
      setLoadError(`규칙 판정 중 오류: ${toKoreanError(e)}`);
      setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.citizenId]);

  useEffect(() => {
    if (!loading && profile) void load();
  }, [loading, profile, load]);

  const credByClaim = useMemo(() => new Map(credentials.map((c) => [`${c.issuerDid}:${c.claim}`, c])), [credentials]);

  // 증명서 상태 (F30): 원장 상태 목록을 목록째 내려받아 내 증명서의 폐기 비트를 이 휴대폰 안에서 확인한다.
  const loaded = data !== null;
  const addresses = data?.addresses ?? null;
  useEffect(() => {
    if (!loaded || credentials.length === 0) return;
    let cancelled = false;
    (async () => {
      const refs = credentials.map((c) => [c.jti, statusRefOf(c.vcJwt)] as const);
      const lists = new Map<string, Uint8Array | null>();
      for (const listId of new Set(refs.map(([, r]) => r?.listId).filter((id): id is string => !!id))) {
        let bits: Uint8Array | null = null;
        if (addresses?.StatusListRegistry) {
          try {
            bits = await readStatusList(addresses, ENV.RPC_URL, listId);
          } catch {
            bits = null;
          }
        }
        lists.set(listId, bits);
      }
      const next: Record<string, boolean | null> = {};
      for (const [jti, ref] of refs) {
        const bits = ref ? lists.get(ref.listId) : null;
        next[jti] = ref && bits ? revokedIn(bits, ref.index) : null;
      }
      if (!cancelled) setRevoked(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [credentials, addresses, loaded]);

  function startIssue() {
    setIssueError(null);
    setIssuedNow([]);
    // 발급할 항목이 있는 첫 발급기관부터
    const first = data?.plans.findIndex((p) => p.issuable.length > 0) ?? -1;
    if (first < 0) return;
    setIssuerIdx(first);
    setPhase('consent');
  }

  function advance(from: number) {
    const next = data?.plans.findIndex((p, i) => i > from && p.issuable.length > 0) ?? -1;
    if (next < 0) {
      void reload().then(() => setPhase('cards'));
    } else {
      setIssuerIdx(next);
      setPhase('consent');
    }
  }

  async function agree() {
    if (!data || !wallet || !profile) return;
    const plan = data.plans[issuerIdx];
    if (!plan) return;
    setPhase('issuing');
    setIssueError(null);
    try {
      const stored = await issueFrom(plan, wallet, profile.citizenId);
      setIssuedNow((v) => [...v, ...stored.map((s) => s.jti)]);
      advance(issuerIdx);
    } catch (e) {
      setIssueError(toKoreanError(e));
      setPhase('consent');
    }
  }

  if (loading || phase === 'loading') return <Spinner label={COPY.common.loading} />;
  if (!wallet || !profile) {
    return (
      <div className="space-y-3">
        <Notice kind="warn">{COPY.common.noWallet}</Notice>
        <LinkButton href="/" full>
          {COPY.common.goHome}
        </LinkButton>
      </div>
    );
  }
  if (phase === 'error' || !data) {
    return (
      <div className="space-y-3">
        <SectionTitle>{COPY.credentials.title}</SectionTitle>
        <Notice kind="error">{loadError ?? COPY.common.connectionError}</Notice>
        <p className="text-[0.9rem] text-muted">발급기관 서버({ENV.ISSUER_DAEGU_URL})에서 규칙 번들을 불러오지 못했습니다.</p>
        <Button full onClick={() => void load()}>
          {COPY.common.retry}
        </Button>
      </div>
    );
  }

  const hashView = HASH_LINE[data.hash.status];
  const hashLine = (
    <p className={['text-[0.9rem] font-semibold', hashView.cls].join(' ')}>
      {hashView.text}
      {data.fromCache && <span className="ml-2 font-normal text-muted">(저장된 규칙 사용)</span>}
    </p>
  );
  const hashNotice =
    data.hash.status === 'mismatch' ? (
      <Notice kind="error">{COPY.credentials.hashBadDetail}</Notice>
    ) : data.hash.status === 'unregistered' ? (
      <Notice kind="error">{COPY.credentials.hashUnregisteredDetail}</Notice>
    ) : data.hash.status === 'unverified' ? (
      <Notice kind="info">{COPY.credentials.hashUnverifiedDetail}</Notice>
    ) : null;
  const now = new Date();

  // ---------- 동의 화면 ----------
  if (phase === 'consent' || phase === 'issuing') {
    const plan = data.plans[issuerIdx];
    if (!plan) return null;
    return (
      <div className="space-y-4">
        <SectionTitle>{COPY.credentials.title}</SectionTitle>
        <Card>
          <h2 className="text-lg font-bold leading-snug">{COPY.credentials.consentTitle(plan.name)}</h2>
          <ul className="mt-3 space-y-1 text-[1.05rem]">
            {plan.issuable.map((d) => (
              <li key={d.claim} className="flex gap-2">
                <span className="text-ok" aria-hidden="true">
                  ✔
                </span>
                <span>{d.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 rounded-xl bg-canvas px-3 py-2 text-[0.95rem] font-semibold text-muted">{COPY.credentials.notIncluded}</p>
        </Card>
        {issueError && <Notice kind="error">{issueError}</Notice>}
        {data.wellKnownErrors[plan.did] && !issueError && (
          <Notice kind="warn">
            {plan.name} 서버 연결 확인 실패: {data.wellKnownErrors[plan.did]}
          </Notice>
        )}
        {phase === 'issuing' ? (
          <Spinner label={COPY.credentials.issuing(plan.name)} />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => (issueError ? advance(issuerIdx) : setPhase(credentials.length > 0 ? 'cards' : 'precheck'))}>
              {issueError ? '건너뛰기' : COPY.credentials.cancel}
            </Button>
            <Button onClick={agree}>{issueError ? COPY.common.retry : COPY.credentials.agree}</Button>
          </div>
        )}
      </div>
    );
  }

  // ---------- 사전 판정 ----------
  if (phase === 'precheck') {
    const anyIssuable = data.plans.some((p) => p.issuable.length > 0);
    return (
      <div className="space-y-4">
        <SectionTitle sub={`규칙 기준: ${data.bundle.tables.medianIncomeSource} · ${COPY.credentials.evalDate(data.evalDate)}`}>{COPY.credentials.title}</SectionTitle>
        {hashLine}
        {hashNotice}
        {Object.entries(data.wellKnownErrors).map(([did, msg]) => (
          <Notice key={did} kind="warn">
            {ISSUERS.find((i) => i.did === did)?.name}: {msg}
          </Notice>
        ))}
        {data.plans.map((plan) => (
          <Card key={plan.did}>
            <h2 className="text-lg font-bold">{plan.name}</h2>
            {plan.issuable.length + plan.denied.length === 0 ? (
              <p className="mt-2 text-[0.9rem] text-muted">없음</p>
            ) : (
              <DataTable
                className="mt-2"
                caption={`${plan.name} 사전 판정`}
                columns={COPY.credentials.precheckColumns}
                rows={[
                  ...plan.issuable.map((d) => ({
                    key: d.claim,
                    cells: [d.label, <span key="v" className="font-semibold whitespace-nowrap text-ok">✔ {COPY.credentials.issuable}</span>],
                  })),
                  ...plan.denied.map((d) => ({
                    key: d.claim,
                    cells: [<span key="l" className="text-muted">{d.label}</span>, <span key="v" className="whitespace-nowrap text-muted">✗ {COPY.credentials.notApplicable}</span>],
                  })),
                ]}
              />
            )}
          </Card>
        ))}
        {data.plans.some((p) => p.denied.length > 0) && <p className="text-[0.85rem] text-muted">{COPY.credentials.deniedHelp}</p>}
        {data.selfChecked.length > 0 && (
          <Card muted>
            <h2 className="text-[1rem] font-bold text-ink">{COPY.credentials.selfChecked}</h2>
            <ul className="mt-1 space-y-0.5 text-[0.95rem]">
              {data.selfChecked.map((d) => (
                <li key={d.claim}>
                  · {d.label}
                  <span className="ml-1 text-[0.85rem]">({COPY.credentials.localValue(d.value)})</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[0.85rem]">{COPY.credentials.selfCheckedNote}</p>
          </Card>
        )}
        <Notice kind="info">{COPY.credentials.localOnly}</Notice>
        <Button full onClick={startIssue} disabled={!data.hash.ok || !anyIssuable}>
          {COPY.credentials.startIssue}
        </Button>
      </div>
    );
  }

  // ---------- 발급 완료 카드 ----------
  return (
    <div className="space-y-4">
      <SectionTitle>{COPY.credentials.title}</SectionTitle>
      {hashLine}
      {issuedNow.length > 0 && <Notice kind="success">{COPY.credentials.done} — 새 증명서 {issuedNow.length}개</Notice>}
      {credentials.length === 0 && <Notice kind="warn">{COPY.credentials.noCredentials}</Notice>}
      {data.plans.map((plan) => {
        const mine = credentials.filter((c) => c.issuerDid === plan.did);
        const deniedRows = plan.denied;
        if (mine.length === 0 && deniedRows.length === 0) return null;
        return (
          <div key={plan.did} className="space-y-2">
            <h2 className="text-[1rem] font-bold text-muted">{plan.name}</h2>
            {mine.map((c) => (
              <CredentialCard key={c.jti} credential={c} status={credentialStatusOf(c, now, revoked[c.jti])} />
            ))}
            {plan.issuable
              .filter((d) => !credByClaim.has(`${plan.did}:${d.claim}`))
              .map((d) => (
                <div key={d.claim} className="rounded-2xl border border-dashed border-line px-4 py-3 text-muted">
                  {d.label} — 아직 발급받지 않음
                </div>
              ))}
            {deniedRows.map((d) => (
              <DeniedRow key={d.claim} label={d.label} />
            ))}
          </div>
        );
      })}
      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={() => setPhase('precheck')}>
          {COPY.credentials.reissue}
        </Button>
        <LinkButton href="/benefits">{COPY.credentials.nextStep}</LinkButton>
      </div>
      <Notice kind="info">{COPY.credentials.localOnly}</Notice>
    </div>
  );
}

/** 챌린지 → 홀더 서명 → 발급 → 저장. 본문에는 시민 식별자·DID·서명·claim 이름·동의 범위만 실린다. */
async function issueFrom(plan: IssuerPlan, wallet: WalletRecord, citizenId: string): Promise<StoredCredential[]> {
  const privateKey = hexToBytes(wallet.privateKey);
  const challenge = await issuerApi.challenge(plan.url, wallet.did);
  const holderProof = signJws({
    header: { alg: 'EdDSA', typ: 'holder-proof+jwt' },
    payload: { iss: wallet.did, aud: challenge.aud, nonce: challenge.nonce },
    privateKey,
  });
  const requestedClaims = plan.issuable.map((d) => d.claim);
  const res = await issuerApi.issue(plan.url, {
    citizenId,
    holderDid: wallet.did,
    holderProof,
    requestedClaims,
    consent: { scope: [...requestedClaims], ts: new Date().toISOString() },
  });
  const issuedAt = new Date().toISOString();
  const stored: StoredCredential[] = res.credentials.map((c) => {
    let value = true;
    try {
      const subject = decodeVc(c.vcJwt).vc.credentialSubject as Record<string, unknown>;
      value = subject[c.claim] === true;
    } catch {
      /* 형식 오류면 발급값을 신뢰 */
    }
    return {
      jti: c.jti,
      claim: c.claim,
      label: c.label,
      value,
      vcJwt: c.vcJwt,
      issuerDid: res.issuer.did,
      issuerName: res.issuer.name,
      statusListIndex: c.statusListIndex,
      validUntil: c.validUntil,
      issuedAt,
    };
  });
  await addCredentials(stored);
  await addConsentReceipt({
    hash: res.consentReceipt.hash,
    txHash: res.consentReceipt.txHash ?? null,
    object: res.consentReceipt.object,
    issuerDid: res.issuer.did,
    issuerName: res.issuer.name,
    claims: requestedClaims,
    at: issuedAt,
  });
  return stored;
}
