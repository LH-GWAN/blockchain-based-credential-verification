/** 순수 포맷 함수. 화면 로직과 분리해 vitest 로 검증한다. */
import type { VerificationResult } from "./types";

/** 830 → "0.83초", 1234.5 → "1.23초" */
export function formatSeconds(ms: number, digits = 2): string {
  const n = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return `${(n / 1000).toFixed(digits)}초`;
}

/** 12.345 → "12ms", 0.4 → "0.4ms" */
export function formatMs(ms: number): string {
  const n = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return n < 1 ? `${n.toFixed(1)}ms` : `${Math.round(n)}ms`;
}

/** 남은 초 → "mm:ss" (음수는 00:00) */
export function formatCountdown(remainingSec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(remainingSec) ? remainingSec : 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** unix 초 만료 시각 → 남은 초(0 이상, 올림) */
export function remainingSeconds(expUnixSec: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil(expUnixSec - nowMs / 1000));
}

/** "123456" → "123 456" (읽기 쉬운 6자리 코드) */
export function groupShortCode(code: string): string {
  const c = code.replace(/\s+/g, "");
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** 긴 해시를 앞·뒤만 남기고 줄인다 */
export function shortHash(h: string | null | undefined, head = 10, tail = 6): string {
  if (!h) return "—";
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** unix 초 → "2026. 9. 14. 오후 1:02:03" */
export function formatDateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString("ko-KR", { hour12: true, dateStyle: "medium", timeStyle: "medium" });
}

/** 결과 → 상태 문구 (§12.3 "상태"). 사유 코드 우선순위대로 하나만 고른다. */
export function statusLabel(r: Pick<VerificationResult, "verdict" | "reasonCodes">): string {
  if (r.verdict === "PASS") return "유효";
  const codes = new Set(r.reasonCodes);
  if (codes.has("REVOKED")) return "폐기됨";
  if (codes.has("EXPIRED")) return "유효기간 만료";
  if (codes.has("NOT_YET_VALID")) return "아직 유효하지 않음";
  if (codes.has("VC_SIG_INVALID")) return "위조·변조";
  if (codes.has("HOLDER_MISMATCH")) return "소유자 불일치";
  if (codes.has("NONCE_REUSED")) return "재사용 차단";
  if (codes.has("NONCE_EXPIRED")) return "요청 만료";
  if (codes.has("ISSUER_UNKNOWN") || codes.has("ISSUER_INACTIVE")) return "발급기관 미등록";
  if (codes.has("RULE_HASH_MISMATCH")) return "규칙 버전 불일치";
  if (codes.has("CLAIM_MISSING") || codes.has("CLAIM_FALSE")) return "요청 항목 미충족";
  return "무효";
}

/** 발급기관 이름 목록(중복 제거, 순서 유지) */
export function issuerNames(r: Pick<VerificationResult, "issuers" | "credentials">): string[] {
  const names: string[] = [];
  const push = (n: string | null | undefined) => {
    if (n && !names.includes(n)) names.push(n);
  };
  Object.values(r.issuers ?? {}).forEach(push);
  (r.credentials ?? []).forEach((c) => push(c.issuerName ?? undefined));
  return names;
}

/** 기관이 실제로 받은 참/거짓 항목 수 */
export function receivedFactCount(r: Pick<VerificationResult, "claims" | "credentials">): number {
  const fromClaims = Object.keys(r.claims ?? {}).length;
  const fromCreds = (r.credentials ?? []).filter((c) => c.claim != null).length;
  return Math.max(fromClaims, fromCreds);
}
