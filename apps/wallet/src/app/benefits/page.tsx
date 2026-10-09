'use client';

import { policyIndex } from '@dbp/rules';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChatBox } from '@/components/ChatBox';
import { LegalBasisList, RecommendationCard, SourceBadge } from '@/components/RecommendationCard';
import { BottomSheet, Button, Card, Collapsible, JsonView, LinkButton, Notice, SectionTitle, Spinner } from '@/components/ui';
import { useWallet } from '@/hooks/useWallet';
import { aiApi, issuerApi } from '@/lib/api';
import { COPY } from '@/lib/copy';
import {
  buildRecommendPayload,
  computeClaims,
  counterChecks,
  credentialHoldings,
  failingClaimLabels,
  filterRecommendations,
  groupEligibleByChannel,
  pickRecommendation,
  resolveCitations,
  submitDocuments,
  templateRecommendation,
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
  /** /recommend 응답 중 불변 조건 7 (규칙 엔진 적격 + 실재 조항 인용) 을 통과한 항목만. */
  recommendations: Recommendation[];
  provider: AiProvider | null;
  disclaimer: string | null;
  error: string | null;
}

/**
 * B. 공공 복지·교통 — 복지멤버십이 이미 안내하는 대상이므로 "추천" 하지 않고 판정 결과만 간결하게 보여준다.
 * 설명은 정책 문서를 그대로 문장화한 템플릿이며 근거 조항을 함께 편다.
 */
function WelfareRow({ policy }: { policy: PolicyMeta }) {
  const rec = templateRecommendation(policy);
  const bases = resolveCitations(policy, rec.citations);
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold leading-snug">{policy.name}</h3>
        <span className="shrink-0 rounded-full border border-line bg-canvas px-2 py-0.5 text-[0.75rem] font-semibold text-muted">{COPY.benefits.welfareBadge}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[0.9rem] text-muted">{policy.summary}</p>
      <Collapsible summary={COPY.benefits.explanation}>
        <div className="space-y-2 pb-2 text-[0.9rem]">
          <SourceBadge isAi={false} />
          <p>{rec.explanation}</p>
          {!policy.basisVerified && <p className="text-[0.8rem] text-warn">{COPY.common.exampleBasis}</p>}
          <p className="font-semibold">
            {COPY.benefits.legalBasis} ({bases.length})
          </p>
          <LegalBasisList bases={bases} />
          <p className="text-muted">
            <span className="font-semibold">{COPY.benefits.howToApply}: </span>
            {policy.howToApply}
          </p>
        </div>
      </Collapsible>
    </Card>
  );
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

    // /recommend 본문은 그대로 (범주값 + 모든 정책의 ruleResults). AI 는 설명만 하고 판정하지 않는다.
    const index = policyIndex(policies);
    const eligible = new Set(payload.ruleResults.filter((r) => r.eligible).map((r) => r.policyId));
    try {
      const res = await aiApi.recommend(payload);
      // 불변 조건 7: 규칙 엔진 적격 + 실재 조항 인용만 노출. 없는 정책은 카드가 템플릿으로 채워진다.
      setAi({ recommendations: filterRecommendations(res.recommendations, index, eligible), provider: res.provider, disclaimer: res.disclaimer, error: null });
    } catch (e) {
      setAi({ recommendations: [], provider: null, disclaimer: null, error: toKoreanError(e) });
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
    const eligible = new Set(data.payload.ruleResults.filter((r) => r.eligible).map((r) => r.policyId));
    const groups = groupEligibleByChannel(index, eligible);
    const ineligible = data.payload.ruleResults
      .filter((r) => !r.eligible)
      .map((r) => ({ policyId: r.policyId, name: index[r.policyId]?.name ?? r.policyId, failing: failingClaimLabels(data.bundle, index[r.policyId], r.policyId, claims) }));
    return { claims, index, groups, ineligible };
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
  const aiRecs = ai?.recommendations ?? [];
  const { counter, welfare } = derived.groups;

  return (
    <div className="space-y-5">
      <SectionTitle sub={COPY.benefits.subtitle}>{COPY.benefits.title}</SectionTitle>
      {credentials.length === 0 && (
        <Notice kind="warn">
          {COPY.benefits.needCredentials} <LinkButton href="/credentials" variant="ghost">증명서 받기</LinkButton>
        </Notice>
      )}
      {ai?.error && <Notice kind="warn">{COPY.benefits.aiUnavailable}</Notice>}

      {/* A. 은행·민간 창구 혜택 — 혜택패스가 증명서 제출로 돕는 대상 (복지멤버십에 없음) */}
      <section aria-labelledby="counter-heading" className="space-y-3">
        <div>
          <h2 id="counter-heading" className="text-[1.1rem] font-bold leading-snug">
            {COPY.benefits.counterSection} <span className="font-normal text-muted">· {counter.length}개</span>
          </h2>
          <p className="mt-1 text-[0.85rem] text-muted">{COPY.benefits.counterNote}</p>
        </div>
        {!ai && <Spinner label={COPY.benefits.aiPreparing} />}
        {counter.length === 0 ? (
          <Notice kind="info">{COPY.benefits.noCounter}</Notice>
        ) : (
          counter.map((policy) => {
            const rec = pickRecommendation(policy, aiRecs);
            return (
              <RecommendationCard
                key={policy.policyId}
                rec={rec}
                policy={policy}
                holdings={credentialHoldings(policy, credentials, derived.claims, data.bundle)}
                isAi={rec.source ? rec.source === 'llm' : isAiProvider}
                submitDocs={submitDocuments(data.bundle, policy, derived.claims)}
                counterChecked={counterChecks(data.bundle, policy, derived.claims)}
                presentHref="/present"
              />
            );
          })
        )}
        {ai?.disclaimer && <p className="text-[0.8rem] text-muted">{ai.disclaimer}</p>}
      </section>

      <Button variant="secondary" full onClick={openSheet}>
        {COPY.benefits.aiPayloadButton}
      </Button>

      {/* B. 공공 복지·교통 — 복지멤버십 안내 대상. 추천하지 않고 판정 결과만 보여준다. */}
      <section aria-labelledby="welfare-heading" className="space-y-3">
        <div>
          <h2 id="welfare-heading" className="text-[1.1rem] font-bold leading-snug">
            {COPY.benefits.welfareSection} <span className="font-normal text-muted">· {welfare.length}개</span>
          </h2>
          <p className="mt-1 text-[0.85rem] text-muted">{COPY.benefits.welfareNote}</p>
        </div>
        {welfare.length === 0 ? <p className="text-[0.9rem] text-muted">{COPY.benefits.noWelfare}</p> : welfare.map((policy) => <WelfareRow key={policy.policyId} policy={policy} />)}
      </section>

      {/* C. 지금은 해당되지 않는 혜택 */}
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
