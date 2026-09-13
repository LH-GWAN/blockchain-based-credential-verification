'use client';

import { policyIndex } from '@dbp/rules';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatBox } from '@/components/ChatBox';
import { RecommendationCard } from '@/components/RecommendationCard';
import { BottomSheet, Button, Card, JsonView, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { aiApi, issuerApi } from '@/lib/api';
import { COPY } from '@/lib/copy';
import {
  buildRecommendPayload,
  computeClaims,
  credentialHoldings,
  failingClaimLabels,
  fillWithTemplates,
  filterRecommendations,
} from '@/lib/eligibility';
import { ENV } from '@/lib/env';
import { toKoreanError } from '@/lib/errors';
import { getCachedBundle, getCachedPolicies, setCachedBundle, setCachedPolicies } from '@/lib/store';
import type { AiProvider, AuditPayload, Bundle, PolicyMeta, RecommendPayload, Recommendation } from '@/lib/types';

interface Loaded {
  bundle: Bundle;
  policies: PolicyMeta[];
  payload: RecommendPayload;
}

interface AiState {
  recommendations: Recommendation[];
  provider: AiProvider | null;
  disclaimer: string | null;
  error: string | null;
}

export default function BenefitsPage() {
  const { loading, wallet, profile, credentials } = useWallet();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiState | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [audit, setAudit] = useState<{ value: AuditPayload | null; error: string | null } | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    setLoadError(null);
    setAi(null);
    const [bRes, pRes] = await Promise.allSettled([issuerApi.bundle(ENV.ISSUER_DAEGU_URL), issuerApi.policies(ENV.ISSUER_DAEGU_URL)]);
    let bundle: Bundle | undefined;
    let policies: PolicyMeta[] | undefined;
    if (bRes.status === 'fulfilled') {
      bundle = bRes.value;
      setCachedBundle(bundle).catch(() => undefined);
    } else bundle = await getCachedBundle().catch(() => undefined);
    if (pRes.status === 'fulfilled') {
      policies = pRes.value;
      setCachedPolicies(policies).catch(() => undefined);
    } else policies = await getCachedPolicies().catch(() => undefined);
    if (!bundle || !policies) {
      setLoadError(toKoreanError(bRes.status === 'rejected' ? bRes.reason : pRes.status === 'rejected' ? pRes.reason : new Error('데이터 없음')));
      return;
    }
    let payload: RecommendPayload;
    try {
      payload = buildRecommendPayload(bundle, profile);
    } catch (e) {
      setLoadError(`규칙 판정 중 오류: ${toKoreanError(e)}`);
      return;
    }
    setData({ bundle, policies, payload });

    const index = policyIndex(policies);
    const eligible = new Set(payload.ruleResults.filter((r) => r.eligible).map((r) => r.policyId));
    try {
      const res = await aiApi.recommend(payload);
      // 불변 조건 7: 규칙 엔진 적격 + 실재 조항 인용만 노출. 부족하면 템플릿으로 채운다.
      const kept = filterRecommendations(res.recommendations, index, eligible);
      setAi({ recommendations: fillWithTemplates(kept, index, eligible), provider: res.provider, disclaimer: res.disclaimer, error: null });
    } catch (e) {
      setAi({ recommendations: fillWithTemplates([], index, eligible), provider: null, disclaimer: null, error: toKoreanError(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.citizenId]);

  useEffect(() => {
    if (!loading && profile) void load();
  }, [loading, profile, load]);

  const derived = useMemo(() => {
    if (!data || !profile) return null;
    const claims = computeClaims(data.bundle, profile);
    const index = policyIndex(data.policies);
    const ineligible = data.payload.ruleResults
      .filter((r) => !r.eligible)
      .map((r) => ({ policyId: r.policyId, name: index[r.policyId]?.name ?? r.policyId, failing: failingClaimLabels(data.bundle, index[r.policyId], r.policyId, claims) }));
    return { claims, index, ineligible };
  }, [data, profile]);

  async function openSheet() {
    setSheetOpen(true);
    setAudit(null);
    try {
      setAudit({ value: await aiApi.auditLastPayload(), error: null });
    } catch (e) {
      setAudit({ value: null, error: toKoreanError(e) });
    }
  }

  if (loading) return <Spinner label={COPY.common.loading} />;
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
  if (loadError) {
    return (
      <div className="space-y-3">
        <SectionTitle>{COPY.benefits.title}</SectionTitle>
        <Notice kind="error">{loadError}</Notice>
        <Button full onClick={() => void load()}>
          {COPY.common.retry}
        </Button>
      </div>
    );
  }
  if (!data || !derived) return <Spinner label={COPY.common.loading} />;

  const isAiProvider = ai?.provider === 'anthropic';

  return (
    <div className="space-y-4">
      <SectionTitle sub={`${COPY.benefits.eligibleNow} ${ai ? ai.recommendations.length : '…'}개`}>{COPY.benefits.title}</SectionTitle>
      {credentials.length === 0 && (
        <Notice kind="warn">
          {COPY.benefits.needCredentials} <LinkButton href="/credentials" variant="ghost">증명서 받기</LinkButton>
        </Notice>
      )}
      {ai?.error && <Notice kind="warn">{COPY.benefits.aiUnavailable}</Notice>}

      {!ai ? (
        <Spinner label="AI 설명을 준비하는 중…" />
      ) : ai.recommendations.length === 0 ? (
        <Notice kind="info">{COPY.benefits.noEligible}</Notice>
      ) : (
        ai.recommendations.map((rec) => {
          const policy = derived.index[rec.policyId];
          return (
            <RecommendationCard
              key={rec.policyId}
              rec={rec}
              policy={policy}
              holdings={policy ? credentialHoldings(policy, credentials, derived.claims, data.bundle) : []}
              isAi={rec.source ? rec.source === 'llm' : isAiProvider}
            />
          );
        })
      )}
      {ai?.disclaimer && <p className="text-[0.8rem] text-muted">{ai.disclaimer}</p>}

      <Button variant="secondary" full onClick={openSheet}>
        {COPY.benefits.aiPayloadButton}
      </Button>

      <Card muted>
        <h2 className="font-bold text-ink">{COPY.benefits.notEligible}</h2>
        {derived.ineligible.length === 0 ? (
          <p className="text-[0.9rem]">없음</p>
        ) : (
          <ul className="mt-1 space-y-1 text-[0.95rem]">
            {derived.ineligible.map((p) => (
              <li key={p.policyId}>
                <span className="font-semibold text-ink">{p.name}</span>
                <span className="block text-[0.85rem]">
                  {COPY.benefits.failingPrefix}
                  {p.failing.join(', ') || '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ChatBox payload={data.payload} />

      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={COPY.benefits.aiPayloadTitle}>
        <Notice kind="info" className="mb-3">
          {COPY.benefits.aiPayloadNote}
        </Notice>
        <h3 className="mb-1 font-semibold">{COPY.benefits.aiPayloadLocal}</h3>
        <JsonView value={data.payload} label={COPY.benefits.aiPayloadLocal} />
        <h3 className="mt-3 mb-1 font-semibold">{COPY.benefits.aiPayloadServer}</h3>
        {!audit ? (
          <Spinner label={COPY.common.loading} />
        ) : audit.error ? (
          <Notice kind="warn">{audit.error}</Notice>
        ) : audit.value && audit.value.available ? (
          <>
            <p className="mb-1 text-[0.85rem] text-muted">
              종류: {audit.value.kind} · 제공자: {audit.value.provider}
              {audit.value.model ? ` · 모델: ${audit.value.model}` : ''}
            </p>
            <JsonView value={audit.value.payload} label={COPY.benefits.aiPayloadServer} />
          </>
        ) : (
          <Notice kind="info">아직 기록된 AI 호출이 없습니다.</Notice>
        )}
      </BottomSheet>
    </div>
  );
}
