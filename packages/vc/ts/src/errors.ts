/**
 * 라이브러리 전역 오류. `code`는 §9 거부 사유 코드와 맞춘다
 * (AUD_MISMATCH, VP_SIG_INVALID, VC_SIG_INVALID, ...). 그 외 입력 오류는 MALFORMED / FLOAT_FORBIDDEN 등.
 */
export class VcError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'VcError';
    this.code = code;
  }
}
