'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { aiApi } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { toKoreanError } from '@/lib/errors';
import type { RecommendPayload } from '@/lib/types';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  provider?: string | null;
  /** 서버가 개인정보로 보이는 부분을 가린 뒤 전달했다. */
  masked?: boolean;
}

function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * 채팅: SSE 스트리밍, 실패 시 /chat/complete 로 폴백. 지갑의 대화는 React 상태에만 있고,
 * 화면을 떠나거나 페이지를 닫으면 AI 서비스에 세션 삭제를 요청한다 (F20 — 서버도 30분 뒤 지운다).
 * 채팅 답변은 판정이 아니다 — 적격 여부는 규칙 엔진 결과만 따른다 (F22).
 */
export function ChatBox({ payload, onAuditId }: { payload: RecommendPayload; onAuditId?: (auditId: string) => void }) {
  const [sessionId] = useState(newSessionId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 화면을 떠날 때(언마운트)·페이지를 닫을 때(pagehide) 서버 세션 삭제 요청. 대화가 시작된 경우에만 보낸다.
  const startedRef = useRef(false);
  useEffect(() => {
    const discard = () => {
      if (startedRef.current) void aiApi.deleteSession(sessionId);
    };
    window.addEventListener('pagehide', discard);
    return () => {
      window.removeEventListener('pagehide', discard);
      discard();
    };
  }, [sessionId]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setError(null);
    setInput('');
    setBusy(true);
    startedRef.current = true;
    setTurns((t) => [...t, { role: 'user', text: message }, { role: 'assistant', text: '' }]);
    const body = { sessionId, message, categoricalProfile: payload.categoricalProfile, ruleResults: payload.ruleResults };
    const appendDelta = (delta: string) =>
      setTurns((t) => {
        const last = t[t.length - 1];
        if (!last || last.role !== 'assistant') return t;
        return [...t.slice(0, -1), { ...last, text: last.text + delta }];
      });
    const setLast = (patch: Partial<Turn>) =>
      setTurns((t) => {
        const last = t[t.length - 1];
        if (!last || last.role !== 'assistant') return t;
        return [...t.slice(0, -1), { ...last, ...patch }];
      });
    try {
      const ac = new AbortController();
      abortRef.current = ac;
      const r = await aiApi.chatStream(body, appendDelta, ac.signal);
      if (r.text.length === 0) throw new Error('empty stream');
      setLast({ provider: r.provider, masked: r.masked });
      if (r.auditId) onAuditId?.(r.auditId);
    } catch (streamErr) {
      // 스트림 실패 → 완성형 엔드포인트로 폴백
      try {
        const r = await aiApi.chatComplete(body);
        setLast({ text: r.text, provider: r.provider, masked: r.masked === true });
        if (r.auditId) onAuditId?.(r.auditId);
      } catch (e) {
        setTurns((t) => t.slice(0, -1));
        setError(toKoreanError(e instanceof Error && e.message !== 'empty stream' ? e : streamErr));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <section aria-label={COPY.benefits.chatTitle} className="rounded-2xl border border-line bg-surface p-3">
      <h2 className="text-lg font-bold">{COPY.benefits.chatTitle}</h2>
      <p className="text-[0.8rem] text-muted">{COPY.benefits.chatNote}</p>
      <p className="text-[0.8rem] text-muted">{COPY.benefits.chatPrivacy}</p>
      <div ref={listRef} className="mt-2 max-h-72 space-y-2 overflow-y-auto" aria-live="polite">
        {turns.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={[
                'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[0.95rem]',
                t.role === 'user' ? 'bg-primary text-white' : 'bg-canvas text-ink',
              ].join(' ')}
            >
              {t.text || (busy ? '…' : '')}
              {t.role === 'assistant' && t.provider && (
                <span className="mt-1 block text-[0.7rem] text-muted">{t.provider === 'anthropic' ? COPY.benefits.aiLabel : COPY.benefits.templateLabel}</span>
              )}
              {t.role === 'assistant' && t.masked && <span className="mt-1 block text-[0.7rem] text-muted">{COPY.benefits.chatMasked}</span>}
            </div>
          </div>
        ))}
      </div>
      {error && (
        <Notice kind="error" className="mt-2">
          {error}
        </Notice>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          {COPY.benefits.chatTitle}
        </label>
        <input
          id="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={COPY.benefits.chatPlaceholder}
          maxLength={4000}
          autoComplete="off"
          className="min-h-12 flex-1 rounded-xl border border-line px-3 text-[1rem]"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || input.trim().length === 0}>
          {COPY.benefits.chatSend}
        </Button>
      </form>
    </section>
  );
}
