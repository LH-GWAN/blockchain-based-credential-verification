'use client';

import { Card, Collapsible, LinkButton } from '@/components/ui';
import { COPY } from '@/lib/copy';
import { resolveCitations, type Holding, type SubmitDocument } from '@/lib/eligibility';
import type { LegalBasis, PolicyMeta, Recommendation } from '@/lib/types';

/** AI 설명 / 규칙 설명(템플릿) 표지. */
export function SourceBadge({ isAi }: { isAi: boolean }) {
  return (
    <span
      className={[
        'shrink-0 rounded-full px-2 py-0.5 text-[0.75rem] font-semibold',
        isAi ? 'bg-primary-soft text-primary-dark' : 'bg-canvas text-muted border border-line',
      ].join(' ')}
    >
      {isAi ? COPY.benefits.aiLabel : COPY.benefits.templateLabel}
    </span>
  );
}

/** 근거 조항 목록 (정책 DB 에 실재하는 조항만 — resolveCitations 결과). */
export function LegalBasisList({ bases }: { bases: readonly LegalBasis[] }) {
  return (
    <ul className="space-y-2 pb-2 text-[0.9rem]">
      {bases.map((b) => (
        <li key={b.clauseId}>
          <p className="font-semibold">{b.title}</p>
          <p className="text-muted">{b.text}</p>
          <a href={b.sourceUrl} target="_blank" rel="noreferrer" className="break-all text-primary-dark underline">
            출처 보기
          </a>
          <span className="ml-2 text-[0.75rem] text-muted">{b.clauseId}</span>
        </li>
      ))}
    </ul>
  );
}

export function RecommendationCard({
  rec,
  policy,
  holdings,
  isAi,
  submitDocs,
  presentHref,
}: {
  rec: Recommendation;
  policy: PolicyMeta | undefined;
  holdings: Holding[];
  isAi: boolean;
  /** 창구에 제출할 증명서 (은행·민간 창구 혜택 카드에만). */
  submitDocs?: SubmitDocument[];
  /** "제출하러 가기" 링크 대상. submitDocs 와 함께 쓴다. */
  presentHref?: string;
}) {
  const bases = resolveCitations(policy, rec.citations);
  const allHeld = holdings.length > 0 && holdings.every((h) => h.held);
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-bold leading-snug">{policy?.name ?? rec.policyId}</h2>
        <SourceBadge isAi={isAi} />
      </div>
      <p className="mt-1 font-semibold text-primary-dark">{rec.headline}</p>
      <p className="mt-2 text-[0.95rem]">{rec.explanation}</p>
      {!policy?.basisVerified && <p className="mt-1 text-[0.8rem] text-warn">{COPY.common.exampleBasis}</p>}

      {submitDocs && (
        <div className="mt-3 rounded-xl border-l-4 border-primary bg-primary-soft px-3 py-2 text-[0.95rem]">
          <p className="font-bold text-primary-dark">
            {COPY.benefits.submitDocs}
            {submitDocs.length === 0 ? '없음' : submitDocs.map((d) => `${d.label} (${d.issuerName})`).join(', ')}
          </p>
          {policy?.verifierHint && (
            <p className="mt-1 text-[0.9rem] text-ink">
              <span className="font-semibold">{COPY.benefits.verifierHint}</span>
              {policy.verifierHint}
            </p>
          )}
          {presentHref && (
            <LinkButton href={presentHref} variant="secondary" className="mt-2">
              {COPY.benefits.goPresent}
            </LinkButton>
          )}
        </div>
      )}

      <div className="mt-3 divide-y divide-line border-y border-line">
        <Collapsible summary={`${COPY.benefits.legalBasis} (${bases.length})`}>
          <LegalBasisList bases={bases} />
        </Collapsible>
        <Collapsible summary={COPY.benefits.howToApply}>
          <p className="pb-2 text-[0.9rem]">{policy?.howToApply ?? '—'}</p>
          {rec.nextSteps && (
            <p className="pb-2 text-[0.9rem] text-muted">
              <span className="font-semibold">{COPY.benefits.nextSteps}: </span>
              {rec.nextSteps}
            </p>
          )}
        </Collapsible>
      </div>

      <div className="mt-3">
        <p className="text-[0.9rem] font-semibold">
          {COPY.benefits.holdings} {allHeld ? '✓' : '✗'}
        </p>
        <ul className="mt-1 space-y-0.5 text-[0.9rem]">
          {holdings.map((h) => (
            <li key={h.claim} className={h.held ? 'text-ok' : 'text-danger'}>
              {h.held ? '✓' : '✗'} {h.label}
              {h.note && <span className="ml-1 text-[0.8rem] text-muted">{h.note}</span>}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
