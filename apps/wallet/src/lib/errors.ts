/** 서비스 오류 코드 → 쉬운 한국어. 코드가 없으면 일반 문구. */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, message: string, status = 0, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const MESSAGES: Record<string, string> = {
  NETWORK: '서버에 연결하지 못했습니다. 서비스가 실행 중인지 확인해 주세요.',
  TIMEOUT: '서버 응답이 없습니다 (시간 초과).',
  VALIDATION: '요청 형식이 올바르지 않습니다.',
  // 발급기관
  RULE_HASH_MISMATCH: '발급기관의 규칙 버전이 공동원장에 등록된 것과 다릅니다. 발급을 진행할 수 없습니다.',
  LEDGER_UNAVAILABLE: '발급기관이 공동원장에 연결할 수 없어 발급을 진행할 수 없습니다.',
  BUNDLE_NOT_REGISTERED: '규칙 번들이 공동원장에 등록되어 있지 않습니다. (make seed 필요)',
  BUNDLE_UNKNOWN: '발급기관이 이 규칙 버전을 지원하지 않습니다.',
  HOLDER_PROOF_INVALID: '지갑 키 확인에 실패했습니다. 다시 시도해 주세요.',
  CONSENT_SCOPE_MISMATCH: '동의 범위와 요청 항목이 일치하지 않습니다.',
  CITIZEN_UNKNOWN: '발급기관에 등록되지 않은 시민 식별자입니다.',
  CLAIM_NOT_ISSUED_HERE: '이 발급기관이 발급하지 않는 항목이 포함되어 있습니다.',
  DEPLOYMENT_UNAVAILABLE: '공동원장 배포 정보를 찾을 수 없습니다.',
  // 검증기관
  REQUEST_UNKNOWN: '해당 코드의 요청을 찾을 수 없습니다. 코드를 다시 확인해 주세요.',
  VERIFIER_UNKNOWN: '알 수 없는 검증기관입니다.',
  NO_PRIOR_SUCCESSFUL_PRESENTATION: '아직 성공한 제출이 없습니다.',
};

/** 검증 거부 사유 코드 → 한국어 (검증 서비스가 reasons 를 주지 않을 때의 예비). */
export const REASON_KO: Record<string, string> = {
  AUD_MISMATCH: '다른 기관에 제출된 증명입니다',
  NONCE_MISSING: '1회용 확인번호가 없습니다',
  NONCE_UNKNOWN: '알 수 없는 검증 요청입니다',
  NONCE_EXPIRED: '검증 요청 시간이 만료되었습니다',
  NONCE_REUSED: '이미 사용된 제출입니다 (재사용 차단)',
  VP_SIG_INVALID: '제출 서명이 올바르지 않습니다',
  ISSUER_UNKNOWN: '원장에 등록되지 않은 발급기관입니다',
  ISSUER_INACTIVE: '정지된 발급기관입니다',
  VC_SIG_INVALID: '증명서 서명이 위조·변조되었습니다',
  EXPIRED: '증명서 유효기간이 지났습니다',
  NOT_YET_VALID: '아직 유효하지 않은 증명서입니다',
  HOLDER_MISMATCH: '제출자가 증명서의 소유자가 아닙니다',
  REVOKED: '폐기된 증명서입니다',
  RULE_HASH_MISMATCH: '판정에 사용된 규칙 버전이 원장과 다릅니다',
  STATUS_LIST_UNAVAILABLE: '원장에서 상태 목록을 찾을 수 없습니다',
  CLAIM_MISSING: '요청한 항목의 증명서가 없습니다',
  CLAIM_FALSE: '요청한 항목이 충족되지 않았습니다',
  VP_MALFORMED: '제출 형식이 올바르지 않습니다',
};

export function messageForCode(code: string, fallback?: string): string {
  return MESSAGES[code] ?? fallback ?? `요청을 처리하지 못했습니다 (${code})`;
}

/** FastAPI `{detail: "CODE:extra"}` / `{detail: [...]}` 에서 코드를 뽑는다. */
export function extractCode(detail: unknown, status: number): string {
  if (detail && typeof detail === 'object' && 'detail' in detail) {
    const d = (detail as { detail: unknown }).detail;
    if (typeof d === 'string') return d.split(':')[0]?.trim() || `HTTP_${status}`;
    if (Array.isArray(d)) return 'VALIDATION';
  }
  if (typeof detail === 'string' && /^[A-Z_]+/.test(detail)) return detail.split(':')[0] as string;
  return `HTTP_${status}`;
}

/** 어떤 예외든 화면에 보여줄 한국어 한 줄로. */
export function toKoreanError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return MESSAGES['TIMEOUT'] as string;
    return err.message || '알 수 없는 오류가 발생했습니다.';
  }
  return '알 수 없는 오류가 발생했습니다.';
}
