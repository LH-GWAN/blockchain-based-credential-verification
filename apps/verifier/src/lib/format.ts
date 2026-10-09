/** 순수 포맷 함수. 화면 로직과 분리해 vitest 로 검증한다. */
import { claimLabel, REQUEST, RESULT } from "./copy";
import type { CredentialInfo, PolicyCheck, Preset, VerificationResult } from "./types";

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
  // 원장에 닿지 못하면 나머지 판단은 근거가 없다 — 원인을 먼저 보인다.
  if (codes.has("LEDGER_UNAVAILABLE")) return "원장 연결 실패";
  if (codes.has("REVOKED")) return "폐기됨";
  if (codes.has("EXPIRED")) return "유효기간 만료";
  if (codes.has("NOT_YET_VALID")) return "아직 유효하지 않음";
  if (codes.has("VC_SIG_INVALID")) return "위조·변조";
  if (codes.has("HOLDER_MISMATCH")) return "소유자 불일치";
  if (codes.has("NONCE_REUSED")) return "재사용 차단";
  if (codes.has("NONCE_EXPIRED")) return "요청 만료";
  if (codes.has("ISSUER_UNKNOWN")) return "발급기관 미등록";
  if (codes.has("ISSUER_INACTIVE")) return "발급기관 정지";
  if (codes.has("ISSUER_NOT_AUTHORITATIVE")) return "발급 권한 없음";
  if (codes.has("STATUS_LIST_OWNER_MISMATCH")) return "상태 목록 불일치";
  if (codes.has("RULE_HASH_MISMATCH") || codes.has("RULE_VERSION_NOT_ACCEPTED")) return "규칙 버전 불일치";
  if (codes.has("UNREQUESTED_CREDENTIAL")) return "요청 외 증명서 포함";
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

/** 항목 라벨 → 사실 문구: "신용평점 하위 20% 여부" + 참 → "신용평점 하위 20%", 거짓 → "신용평점 하위 20% 아님" */
export function factLabel(label: string, expected: boolean): string {
  const base = label.replace(/\s*\(창구 자체 조회\)$/, "").replace(/\s*여부$/, "");
  return expected ? base : `${base} 아님`;
}

/**
 * 정책 판정 카드의 보조 문구. 없으면 null.
 * - pending: 판정 불가(eligible=null)일 때 결과를 바꾸는 미제출 항목
 * - counterChecked: 증명서가 아니라 창구가 자체 조회해 판정에 넣은 항목
 * 라벨은 서버 응답의 label 이 우선, 없으면 내장 라벨.
 */
export function policyCheckNotes(pc: PolicyCheck): { pending: string | null; counterChecked: string | null } {
  const undecided = pc.eligible === null ? (pc.pending ?? []) : [];
  // 신용평점처럼 시민이 제출할 수 없는 항목(창구 조회)은 '미제출'이 아니라 '창구 확인 필요'로 따로 적는다
  const missing = undecided.filter((p) => !p.counterCheck).map((p) => claimLabel(p.claim, p.label || undefined));
  const needsCounter = undecided.filter((p) => p.counterCheck).map((p) => factLabel(claimLabel(p.claim, p.label || undefined), true));
  const pending = [
    missing.length ? RESULT.policyPending(missing.join(" · ")) : null,
    needsCounter.length ? RESULT.policyNeedsCounter(needsCounter.join(" · ")) : null,
  ].filter((s): s is string => s !== null);
  const counter = (pc.counterChecked ?? []).map((c) => factLabel(claimLabel(c.claim, c.label || undefined), c.expected));
  return {
    pending: pending.length ? pending.join(" / ") : null,
    counterChecked: counter.length ? RESULT.policyCounterChecked(counter.join(" · ")) : null,
  };
}

/** 요청 화면: 활성 프리셋이 창구 자체 조회를 전제하면 "창구가 먼저 확인: …" (없으면 null). 라벨은 /claims 응답이 우선. */
export function presetCounterCheckedNote(
  preset: Pick<Preset, "counterChecked"> | null | undefined,
  labels: readonly { claim: string; label: string }[] = [],
): string | null {
  const items = (preset?.counterChecked ?? []).map((c) =>
    factLabel(claimLabel(c.claim, labels.find((l) => l.claim === c.claim)?.label || undefined), c.expected),
  );
  return items.length ? REQUEST.presetCounterChecked(items.join(" · ")) : null;
}

/**
 * 증명서별 상세의 값 표시 (F38). 해석하지 못한 증명서(value=null)는 '거짓'이 아니라 확인 안 함(중립색)이다.
 */
export function credentialValueLabel(value: CredentialInfo["value"]): { text: string; tone: "pass" | "fail" | "muted" } {
  if (value === true) return { text: RESULT.yes, tone: "pass" };
  if (value === false) return { text: RESULT.no, tone: "fail" };
  return { text: RESULT.valueUnchecked, tone: "muted" };
}

export type AttackOutcome = "blocked" | "other-reason" | "not-blocked";

/**
 * 공격 결과 판정 (F28·F29). '차단됨'은 FAIL 이면서 그 공격의 예상 사유 코드가 있을 때만이다.
 * FAIL 이지만 예상 코드가 없으면 다른 단계에서 막힌 것이라 그 공격을 막았다는 근거가 되지 못한다.
 */
export function attackOutcome(r: Pick<VerificationResult, "verdict" | "reasonCodes">, expected: string): AttackOutcome {
  if (r.verdict !== "FAIL") return "not-blocked";
  return r.reasonCodes.includes(expected) ? "blocked" : "other-reason";
}
