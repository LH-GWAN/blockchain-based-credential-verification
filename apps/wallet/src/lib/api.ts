/**
 * 지갑의 모든 네트워크 호출은 이 모듈을 통해서만 나간다 (test/privacy.test.ts 가 grep 으로 강제).
 * 밖으로 나가는 요청 본문은 다음뿐이다:
 *  - 발급기관: { holderDid } / { citizenId, holderDid, holderProof, requestedClaims[], consent{scope, ts} }
 *  - AI:       { categoricalProfile(범주값 6개), ruleResults[], locale } / (+ sessionId, message)
 *  - 검증기관: { requestId, vpJwt }
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
  PolicyMeta,
  PresentResult,
  PresentationRequest,
  RecommendPayload,
  RecommendResponse,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

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
    res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
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

function getJson<T>(url: string): Promise<T> {
  return request<T>(url, { method: 'GET', headers: { accept: 'application/json' } });
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------- 발급기관 (대구광역시 :8001 / iM뱅크 :8003) ----------

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
  present: (body: { requestId: string; vpJwt: string }) => postJson<PresentResult>(`${ENV.VERIFIER_URL}/present`, body),
  result: (requestId: string) => getJson<PresentResult>(`${ENV.VERIFIER_URL}/results/${encodeURIComponent(requestId)}`),
};

// ---------- AI (:8004) — 범주값만 ----------

export interface ChatStreamResult {
  provider: string | null;
  text: string;
}

async function chatStream(payload: ChatPayload, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<ChatStreamResult> {
  const url = `${ENV.AI_URL}/chat`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
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
  for (;;) {
    const { value, done } = await reader.read();
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
        let evt: { delta?: string; done?: boolean; provider?: string };
        try {
          evt = JSON.parse(raw);
        } catch {
          continue;
        }
        if (typeof evt.delta === 'string') {
          text += evt.delta;
          onDelta(evt.delta);
        }
        if (evt.done) provider = evt.provider ?? provider;
      }
    }
  }
  return { provider, text };
}

export const aiApi = {
  recommend: (payload: RecommendPayload) => postJson<RecommendResponse>(`${ENV.AI_URL}/recommend`, payload),
  chatStream,
  chatComplete: (payload: ChatPayload) => postJson<ChatCompleteResponse>(`${ENV.AI_URL}/chat/complete`, payload),
  auditLastPayload: () => getJson<AuditPayload>(`${ENV.AI_URL}/audit/last-payload`),
};
