'use client';

import { Card, Collapsible } from '@/components/ui';
import { COPY } from '@/lib/copy';
import { resolveCitations, type Holding } from '@/lib/eligibility';
import type { PolicyMeta, Recommendation } from '@/lib/types';

export function RecommendationCard({
  rec,
  policy,
  holdings,
  isAi,
}: {
  rec: Recommendation;
  policy: PolicyMeta | undefined;
  holdings: Holding[];
  isAi: boolean;
}) {
  const bases = resolveCitations(policy, rec.citations);
  const allHeld = holdings.length > 0 && holdings.every((h) => h.held);
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-bold leading-snug">{policy?.name ?? rec.policyId}</h2>
        <span
          className={[
            'shrink-0 rounded-full px-2 py-0.5 text-[0.75rem] font-semibold',
            isAi ? 'bg-primary-soft text-primary-dark' : 'bg-canvas text-muted border border-line',
          ].join(' ')}
        >
          {isAi ? COPY.benefits.aiLabel : COPY.benefits.templateLabel}
        </span>
      </div>
      <p className="mt-1 font-semibold text-primary-dark">{rec.headline}</p>
      <p className="mt-2 text-[0.95rem]">{rec.explanation}</p>
      {!policy?.basisVerified && <p className="mt-1 text-[0.8rem] text-warn">{COPY.common.exampleBasis}</p>}

      <div className="mt-3 divide-y divide-line border-y border-line">
        <Collapsible summary={`${COPY.benefits.legalBasis} (${bases.length})`}>
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
