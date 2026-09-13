'use client';

import { useCallback, useEffect, useState } from 'react';
import { getCitizen } from '@/lib/eligibility';
import { getCredentials, getWallet } from '@/lib/store';
import type { CitizenProfile, StoredCredential, WalletRecord } from '@/lib/types';

export interface WalletState {
  loading: boolean;
  wallet: WalletRecord | undefined;
  profile: CitizenProfile | undefined;
  credentials: StoredCredential[];
  error: string | null;
  reload: () => Promise<void>;
}

/** IndexedDB 의 지갑·증명서를 읽는다. 프로필은 지갑에 기록된 citizenId 로 단말 내 합성 데이터에서 찾는다. */
export function useWallet(): WalletState {
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState<WalletRecord | undefined>(undefined);
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([getWallet(), getCredentials()]);
      setWallet(w);
      setCredentials(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장소를 읽지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { loading, wallet, profile: wallet ? getCitizen(wallet.citizenId) : undefined, credentials, error, reload };
}
