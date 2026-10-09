/**
 * 지갑의 모든 네트워크 호출은 이 모듈을 통해서만 나간다 (test/privacy.test.ts 가 grep 으로 강제).
 * 밖으로 나가는 요청 본문은 다음뿐이다:
 *  - 발급기관: { holderDid } / { citizenId, holderDid, holderProof, requestedClaims[], consent{scope, ts} }
 *  - AI:       { categoricalProfile(범주값 6개), ruleResults[], locale } / (+ sessionId, message)
 *  - 검증기관: { requestId, vpJwt } (결과 조회는 헤더 X-Vp-Hash = 내 제출물의 해시)
 *  - AI 상담 기록 삭제: DELETE /chat/{sessionId} (본문 없음)
 * 원본 프로필(이름·생년월일·소득 금액 등)은 어떤 본문에도 들어가지 않는다.
 */
import { BUNDLE, ENV } from './env';
import { ApiError, extractCode, messageForCode } from './errors';
import type {
  AuditPayload,
  Bundle,
  ChallengeResponse,
  ChatCompleteResponse,
  ChatPayload,
  IssueBody,
  IssueResponse,
  IssuerWellKnown,
  LedgerDeployment,
  PendingResult,
  PolicyMeta,
  PresentResult,
  PresentationRequest,
  RecommendPayload,
  RecommendResponse,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * AI 설명·상담: 서버는 LLM 을 25초 안에 포기하고 템플릿으로 답하므로(F18), 지갑은 그보다 넉넉히 기다린다.
 * 그래야 키를 넣은 시연에서도 'AI 서비스에 연결하지 못했습니다' 대신 템플릿 답이 화면에 온다.
 */
export const AI_TIMEOUT_MS = 45_000;
/** 제출: 이 시간 안에 응답이 없으면 다시 POST 하지 않고 결과를 조회한다 (F34 — 같은 1회용 확인번호 재제출 방지). */
export const PRESENT_TIMEOUT_MS = 15_000;

/** 호출자가 준 signal 과 시간 제한을 함께 건다. */
function withTimeout(ms: number, signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const ac = new AbortController();
  const abort = (s: AbortSignal) => () => ac.abort(s.reason);
  signal.addEventListener('abort', abort(signal), { once: true });
  timeout.addEventListener('abort', abort(timeout), { once: true });
  return ac.signal;
}

function isTimeoutLike(e: unknown): boolean {
  const name = e && typeof e === 'object' ? (e as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function request<T>(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: withTimeout(timeoutMs, init.signal) });
  } catch (e) {
    if (isTimeoutLike(e)) {
      throw new ApiError('TIMEOUT', `${messageForCode('TIMEOUT')} (${hostOf(url)})`, 0, e);
    }
    throw new ApiError('NETWORK', `서버에 연결하지 못했습니다 (${hostOf(url)})`, 0, e);
  }
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = undefined;
    }
    const code = extractCode(detail, res.status);
    throw new ApiError(code, messageForCode(code, `요청을 처리하지 못했습니다 (HTTP ${res.status})`), res.status, detail);
  }
  return (await res.json()) as T;
}

function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return request<T>(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
}

function postJson<T>(url: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  return request<T>(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

// ---------- 발급기관 (대구광역시 :8001 / 사회보장정보원(복지기관) :8003) — 공공기관만 발급, 은행은 검증기관 ----------

export const issuerApi = {
  wellKnown: (base: string) => getJson<IssuerWellKnown>(`${base}/.well-known/issuer`),
  bundle: (base: string) => getJson<Bundle>(`${base}/rules/bundles/${BUNDLE.bundle}/${BUNDLE.version}`),
  policies: (base: string) => getJson<PolicyMeta[]>(`${base}/policies`),
  ledgerDeployment: (base: string) => getJson<LedgerDeployment>(`${base}/ledger/deployment`),
  challenge: (base: string, holderDid: string) =>
    postJson<ChallengeResponse>(`${base}/credentials/challenge`, { holderDid }),
  issue: (base: string, body: IssueBody) => postJson<IssueResponse>(`${base}/credentials/issue`, body),
};

// ---------- 검증기관 (:8002) ----------

export const verifierApi = {
  request: (idOrCode: string) =>
    getJson<PresentationRequest>(`${ENV.VERIFIER_URL}/requests/${encodeURIComponent(idOrCode)}`),
  present: (body: { requestId: string; vpJwt: string }) => postJson<PresentResult>(`${ENV.VERIFIER_URL}/present`, body, PRESENT_TIMEOUT_MS),
  /** 내 제출 결과 조회. 권한은 내 제출물의 해시(X-Vp-Hash) — 결과가 아직 없으면 { status: 'pending' }. */
  result: (requestId: string, vpHash: string) =>
    getJson<PresentResult | PendingResult>(`${ENV.VERIFIER_URL}/results/${encodeURIComponent(requestId)}`, { 'x-vp-hash': vpHash }),
};

// ---------- AI (:8004) — 범주값만 ----------

export interface ChatStreamResult {
  provider: string | null;
  text: string;
  /** 응답 헤더 X-Audit-Id — 이 호출의 감사 기록 번호. */
  auditId: string | null;
  masked: boolean;
  notice: string | null;
}

async function chatStream(payload: ChatPayload, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<ChatStreamResult> {
  const url = `${ENV.AI_URL}/chat`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: withTimeout(AI_TIMEOUT_MS, signal),
    });
  } catch (e) {
    if (isTimeoutLike(e)) throw new ApiError('TIMEOUT', `${messageForCode('TIMEOUT')} (${hostOf(url)})`, 0, e);
    throw new ApiError('NETWORK', `서버에 연결하지 못했습니다 (${hostOf(url)})`, 0, e);
  }
  if (!res.ok || !res.body) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = undefined;
    }
    const code = extractCode(detail, res.status);
    throw new ApiError(code, messageForCode(code, `AI 상담 요청을 처리하지 못했습니다 (HTTP ${res.status})`), res.status, detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let provider: string | null = null;
  let masked = false;
  let notice: string | null = null;
  let auditId = res.headers.get('x-audit-id');
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (isTimeoutLike(e)) throw new ApiError('TIMEOUT', `${messageForCode('TIMEOUT')} (${hostOf(url)})`, 0, e);
      throw new ApiError('NETWORK', `AI 상담 응답이 끊겼습니다 (${hostOf(url)})`, 0, e);
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let evt: { delta?: string; done?: boolean; provider?: string; masked?: boolean; notice?: string; auditId?: string };
        try {
          evt = JSON.parse(raw);
        } catch {
          continue;
        }
        if (typeof evt.delta === 'string') {
          text += evt.delta;
          onDelta(evt.delta);
        }
        if (evt.done) {
          provider = evt.provider ?? provider;
          if (evt.masked === true) masked = true;
          if (typeof evt.notice === 'string') notice = evt.notice;
          if (!auditId && typeof evt.auditId === 'string') auditId = evt.auditId;
        }
      }
    }
  }
  return { provider, text, auditId, masked, notice };
}

export const aiApi = {
  recommend: (payload: RecommendPayload) => postJson<RecommendResponse>(`${ENV.AI_URL}/recommend`, payload, AI_TIMEOUT_MS),
  chatStream,
  chatComplete: (payload: ChatPayload) => postJson<ChatCompleteResponse>(`${ENV.AI_URL}/chat/complete`, payload, AI_TIMEOUT_MS),
  /** 이 단말이 받은 기록 번호의 감사 기록만 본다 (다른 사람의 호출은 볼 수 없다 — F12). */
  audit: (auditId: string) => getJson<AuditPayload>(`${ENV.AI_URL}/audit/${encodeURIComponent(auditId)}`),
  /** 상담 화면을 떠날 때 서버 세션 삭제 요청 (F20). 페이지가 닫혀도 전송되도록 keepalive. 실패는 무시 — 서버도 30분 뒤 지운다. */
  deleteSession: (sessionId: string) =>
    request<unknown>(`${ENV.AI_URL}/chat/${encodeURIComponent(sessionId)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined),
};
