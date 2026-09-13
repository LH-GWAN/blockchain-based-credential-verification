'use client';

import { generateHolderKey } from '@dbp/vc';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Collapsible, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { COPY } from '@/lib/copy';
import { CITIZENS, citizenSummary } from '@/lib/eligibility';
import { DEFAULT_CITIZEN_ID } from '@/lib/env';
import { toKoreanError } from '@/lib/errors';
import { shortDid } from '@/lib/format';
import { bytesToHex } from '@/lib/hex';
import { resetWallet, saveWallet } from '@/lib/store';

/** 한 줄 표어 + 역할 구분 (복지 안내 = 복지멤버십, 창구 증명 = 혜택패스). */
function Tagline() {
  return (
    <>
      {COPY.tagline}
      <span className="mt-0.5 block text-[0.85rem] font-semibold text-primary-dark">{COPY.subTagline}</span>
    </>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { loading, wallet, profile, credentials, reload } = useWallet();
  const [citizenId, setCitizenId] = useState(DEFAULT_CITIZEN_ID);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createWallet() {
    setBusy(true);
    setError(null);
    try {
      const key = generateHolderKey();
      await saveWallet({
        privateKey: bytesToHex(key.privateKey),
        publicKey: bytesToHex(key.publicKey),
        did: key.did,
        citizenId,
        createdAt: new Date().toISOString(),
      });
      router.push('/credentials');
    } catch (e) {
      setError(toKoreanError(e));
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm(COPY.home.resetConfirm)) return;
    setBusy(true);
    try {
      await resetWallet();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner label={COPY.common.loading} />;

  if (wallet) {
    const s = profile ? citizenSummary(profile) : null;
    return (
      <div className="space-y-4">
        <SectionTitle sub={<Tagline />}>{COPY.home.walletExists}</SectionTitle>
        <Card>
          {s ? (
            <p className="text-lg font-bold">
              {s.name} · {s.sigungu} · {s.householdSize}인 가구 · {s.ageBand}
            </p>
          ) : (
            <p className="font-bold">{wallet.citizenId}</p>
          )}
          <p className="mt-1 break-all text-[0.85rem] text-muted">지갑 주소 {shortDid(wallet.did, 28)}</p>
          <p className="mt-1 text-[0.85rem] text-muted">받은 증명서 {credentials.length}개</p>
        </Card>
        <LinkButton href={credentials.length > 0 ? '/benefits' : '/credentials'} full>
          {COPY.home.continueLabel}
        </LinkButton>
        <Collapsible summary={COPY.home.settings}>
          <div className="space-y-2 pb-2">
            <p className="text-[0.9rem] text-muted">{COPY.home.keyNote}</p>
            <Button variant="danger" full onClick={reset} disabled={busy}>
              {COPY.home.resetWallet}
            </Button>
          </div>
        </Collapsible>
        <p className="text-[0.8rem] text-muted">{COPY.syntheticNotice}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionTitle sub={<Tagline />}>{COPY.home.title}</SectionTitle>
      <Card>
        <label htmlFor="citizen" className="mb-1 block font-semibold">
          {COPY.home.selectLabel}
        </label>
        <select
          id="citizen"
          value={citizenId}
          onChange={(e) => setCitizenId(e.target.value)}
          className="min-h-12 w-full rounded-xl border border-line bg-white px-3 text-[1rem]"
        >
          {CITIZENS.map((c) => {
            const s = citizenSummary(c);
            return (
              <option key={c.citizenId} value={c.citizenId}>
                {s.name} · {s.sigungu} · {s.householdSize}인 가구 · {s.ageBand}
              </option>
            );
          })}
        </select>
        <p className="mt-2 text-[0.85rem] text-muted">{COPY.home.keyNote}</p>
      </Card>
      {error && <Notice kind="error">{error}</Notice>}
      <Button full onClick={createWallet} disabled={busy}>
        {busy ? COPY.home.creating : COPY.home.createWallet}
      </Button>
      <p className="text-[0.8rem] text-muted">{COPY.syntheticNotice}</p>
    </div>
  );
}
