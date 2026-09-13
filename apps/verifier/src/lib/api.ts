/**
 * 검증 서비스 클라이언트. 이 앱이 호출하는 유일한 백엔드는 NEXT_PUBLIC_VERIFIER_URL 이다.
 * 발급기관 서버에는 절대 접속하지 않는다 — 검증기관은 공동원장만 조회한다 (프롬프트 §2-5).
 * fetch 호출은 이 파일에만 둔다 (test/api-isolation.test.ts 가 강제).
 */
import type {
  AttackKind,
  ClaimDef,
  Health,
  PresentationRequest,
  ResultResponse,
  VerificationResult,
  VerifierProfile,
} from "./types";

export const VERIFIER_URL = (process.env.NEXT_PUBLIC_VERIFIER_URL ?? "http://localhost:8002").replace(/\/+$/, "");

/** 서비스가 응답했지만 4xx/5xx 인 경우. `code` 는 FastAPI `detail` 문자열(예: REQUEST_UNKNOWN). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

/** 서비스에 닿지 못한 경우(꺼져 있음, CORS, 타임아웃). 화면은 "검증 서비스에 연결할 수 없습니다" 로 표시. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("VERIFIER_UNREACHABLE");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export function isUnreachable(e: unknown): e is NetworkError {
  return e instanceof NetworkError;
}

export function isApiError(e: unknown, status?: number): e is ApiError {
  return e instanceof ApiError && (status === undefined || e.status === status);
}

type Json = Record<string, unknown> | unknown[];

async function call<T>(path: string, init: { method?: "GET" | "POST"; body?: Json; timeoutMs?: number } = {}): Promise<T> {
  const { method = "GET", body, timeoutMs = 8000 } = init;
  let res: Response;
  try {
    res = await fetch(`${VERIFIER_URL}${path}`, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new NetworkError(e);
  }
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data.detail === "string") code = data.detail;
    } catch {
      /* 본문 없음 */
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export const api = {
  /** GET /health → { ok, ledgerConnected } */
  health: () => call<Health>("/health", { timeoutMs: 3000 }),

  /** GET /verifiers → 기관 프로필 목록 */
  verifiers: () => call<VerifierProfile[]>("/verifiers"),

  /** GET /claims → 요청 가능한 항목(claim, label) */
  claims: () => call<ClaimDef[]>("/claims"),

  /** POST /requests → QR 페이로드(+ qrText) */
  createRequest: (body: { verifierId: string; purpose: string; requested: { claim: string; expected: boolean }[] }) =>
    call<PresentationRequest>("/requests", { method: "POST", body }),

  /** GET /requests/{id|shortCode} */
  getRequest: (idOrCode: string) => call<Omit<PresentationRequest, "qrText">>(`/requests/${encodeURIComponent(idOrCode)}`),

  /** GET /results/{requestId} → pending | done */
  getResult: (requestId: string) => call<ResultResponse>(`/results/${encodeURIComponent(requestId)}`),

  /** POST /demo/attack → 차단 결과 (409 = 정상 제출 이력 없음) */
  attack: (kind: AttackKind) => call<VerificationResult>("/demo/attack", { method: "POST", body: { kind } }),
};
