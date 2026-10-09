/**
 * 결과·공격 화면 조각을 정적 렌더해 확인한다.
 * - F09: FAIL 이면 정책 판정 카드·비교 패널('실제로 받은 것 ✓')을 그리지 않는다.
 * - F27: 원장 트랜잭션 해시는 data-testid="receipt-tx" 요소에만, txHash 가 있을 때만.
 * - F39·F08: 확인 숫자(data-testid="confirm-code")·제출 지갑·다른 제출 시도 수.
 * - F38: 해석하지 못한 증명서 값은 '거짓'이 아니라 '확인 안 함'.
 * - F26·F29: 공격 카드·결과 블록 data-testid, '차단됨'은 예상 사유 코드가 있을 때만.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttackPanel, AttackVerdict } from "@/components/AttackPanel";
import { ChecksList, CredentialDetails, ReceiptPanel, SubmissionCheck } from "@/components/ResultParts";
import { ResultDetails } from "@/components/ResultView";
import { ATTACK, CHECK_LABELS, RESULT } from "@/lib/copy";
import { ATTACK_KINDS, CHECK_KEYS, type VerificationResult } from "@/lib/types";

const HASH = `0x${"ab".repeat(32)}`;
const TX = `0x${"cd".repeat(32)}`;

function result(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    requestId: "req-1",
    verdict: "PASS",
    reasonCodes: [],
    reasons: [],
    verifier: { did: "did:web:bank", name: "iM뱅크 칠성동지점", kind: "bank" },
    purpose: "햇살론 일반보증 대상 확인",
    requested: [{ claim: "annualIncomeUnder35M", expected: true, label: "연소득 3,500만 원 이하 여부" }],
    claims: { annualIncomeUnder35M: true },
    issuers: { annualIncomeUnder35M: "사회보장정보원(복지기관)" },
    credentials: [{ issuerDid: "did:web:welfare", issuerName: "사회보장정보원(복지기관)", claim: "annualIncomeUnder35M", value: true, checks: {} }],
    checks: Object.fromEntries(CHECK_KEYS.map((k) => [k, true])),
    timingsMs: { total: 120 },
    holderDidShort: "did:key:z6MkholderAAAAAAAA…",
    receipt: { hash: HASH, txHash: TX, object: { vpHash: HASH } },
    verifiedAt: 1_800_000_000,
    confirmCode: "0427",
    otherAttempts: 0,
    policyCheck: { policyId: "sunshine-loan-general", eligible: true, pending: [], counterChecked: [] },
    comparison: {
      presetId: "sunshine-general",
      pullDocuments: [{ id: "income", name: "소득금액증명", issuer: "국세청", fields: ["성명"], source: "서식" }],
      pullItems: ["성명", "주민등록번호"],
      pullCount: 10,
      holdItems: ["연소득 3,500만 원 이하 = 참"],
      holdCount: 1,
      reductionPercent: 90,
      summary: "이번 검증에서 줄어든 항목: 10 → 1 (90%)",
      pullRecords: "3년 보관",
      holdRecords: "원장에 해시 1건",
      honestyNote: "예시",
    },
    ...over,
  };
}

const testIdText = (html: string, id: string) => new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? null;

describe("ResultDetails (F09)", () => {
  it("PASS: 정책 판정 카드·비교 패널이 보인다", () => {
    const html = renderToStaticMarkup(<ResultDetails result={result()} txTimedOut={false} />);
    expect(html).toContain(RESULT.policyCheck);
    expect(html).toContain('data-testid="comparison-panel"');
  });

  it("FAIL(폐기): 초록 '적격'·'이번에 실제로 받은 것 ✓'를 그리지 않는다 — 서버가 policyCheck 를 넣어 와도", () => {
    const html = renderToStaticMarkup(
      <ResultDetails result={result({ verdict: "FAIL", reasonCodes: ["REVOKED"], reasons: ["폐기된 증명서입니다"] })} txTimedOut={false} />,
    );
    expect(html).toContain(RESULT.fail);
    expect(html).toContain("REVOKED");
    expect(html).not.toContain(RESULT.policyCheck);
    expect(html).not.toContain(RESULT.eligible);
    expect(html).not.toContain('data-testid="comparison-panel"');
  });

  it("FAIL 응답에 policyCheck 가 없어도(새 서버) 그대로 렌더된다", () => {
    const html = renderToStaticMarkup(
      <ResultDetails result={result({ verdict: "FAIL", reasonCodes: ["NONCE_EXPIRED"], policyCheck: undefined })} txTimedOut={false} />,
    );
    expect(html).toContain("NONCE_EXPIRED");
  });
});

describe("ReceiptPanel (F27)", () => {
  it("txHash 가 있으면 receipt-tx 요소에 그 해시", () => {
    const html = renderToStaticMarkup(<ReceiptPanel result={result()} txTimedOut={false} />);
    expect(testIdText(html, "receipt-tx")).toBe(TX);
  });

  it("txHash 가 없으면 receipt-tx 가 없다 — 영수증 해시(같은 0x64 형식)만 보여도 앵커 성공으로 보지 않게", () => {
    for (const txTimedOut of [false, true]) {
      const html = renderToStaticMarkup(<ReceiptPanel result={result({ receipt: { hash: HASH, txHash: null, object: {} } })} txTimedOut={txTimedOut} />);
      expect(html).toMatch(/0x[0-9a-f]{64}/);
      expect(html).not.toContain('data-testid="receipt-tx"');
    }
  });

  it("제출 지갑 DID 가 빠진 응답은 '—'", () => {
    const html = renderToStaticMarkup(<ReceiptPanel result={result({ holderDidShort: undefined })} txTimedOut={false} />);
    expect(html).toContain(`${RESULT.holder}: <code class="mono">—</code>`);
  });
});

describe("SubmissionCheck (F39·F08)", () => {
  it("확인 숫자 4자리와 제출 지갑을 보여 준다", () => {
    const html = renderToStaticMarkup(<SubmissionCheck result={result()} />);
    expect(testIdText(html, "confirm-code")).toBe("0427");
    expect(html).toContain(RESULT.confirmCodeHint);
    expect(html).toContain("did:key:z6MkholderAAAAAAAA…");
    expect(html).not.toContain('data-testid="other-attempts"');
  });

  it("다른 제출 시도가 있으면 건수를 경고한다", () => {
    const html = renderToStaticMarkup(<SubmissionCheck result={result({ otherAttempts: 2 })} />);
    expect(html).toContain('data-testid="other-attempts"');
    expect(html).toContain(RESULT.otherAttempts(2));
  });

  it("확인 숫자·시도 수가 없는 응답(이전 서버)은 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<SubmissionCheck result={result({ confirmCode: undefined, otherAttempts: undefined })} />)).toBe("");
  });
});

describe("ChecksList (F32)", () => {
  it("발급기관 정지·유효기간 만료가 체크리스트에 ✗ 로 드러난다", () => {
    const checks = { ...result().checks, issuerActive: false, notExpired: false };
    const html = renderToStaticMarkup(<ChecksList result={result({ verdict: "FAIL", reasonCodes: ["EXPIRED"], checks })} />);
    for (const k of CHECK_KEYS) expect(html).toContain(CHECK_LABELS[k]);
    expect(html.match(/<li /g)).toHaveLength(11);
  });
});

describe("CredentialDetails (F38)", () => {
  it("해석하지 못한 증명서(value=null)는 '값: 거짓'이 아니라 '확인 안 함'", () => {
    const html = renderToStaticMarkup(
      <CredentialDetails result={result({ credentials: [{ issuerDid: "did:web:unknown", claim: null, value: null, checks: { issuerRegistered: false } }] })} />,
    );
    expect(html).toContain(`${RESULT.credValue}: ${RESULT.valueUnchecked}`);
    expect(html).not.toContain(`${RESULT.credValue}: ${RESULT.no}`);
  });

  it("값이 거짓이면 그대로 '거짓'", () => {
    const html = renderToStaticMarkup(<CredentialDetails result={result({ credentials: [{ claim: "annualIncomeUnder35M", value: false }] })} />);
    expect(html).toContain(`${RESULT.credValue}: ${RESULT.no}`);
  });
});

describe("AttackPanel (F26·F28·F29)", () => {
  it("카드 4개에 attack-card-<kind>, 실행 전에는 결과 블록이 없다", () => {
    const html = renderToStaticMarkup(<AttackPanel />);
    for (const kind of ATTACK_KINDS) expect(html).toContain(`data-testid="attack-card-${kind}"`);
    expect(html).not.toContain('data-testid="attack-result-');
    // 설명 배지에는 예상 코드가 처음부터 보이지만 '… 확인'·'차단됨'은 없다
    expect(html).not.toContain(ATTACK.confirmed("NONCE_REUSED"));
    expect(html).not.toContain(ATTACK.blocked);
  });

  it("예상 코드로 막혔을 때만 '차단됨 · CODE 확인'", () => {
    const html = renderToStaticMarkup(<AttackVerdict outcome="blocked" expected="NONCE_REUSED" />);
    expect(html).toContain(ATTACK.blocked);
    expect(html).toContain(ATTACK.confirmed("NONCE_REUSED"));
  });

  it("다른 사유로 거부·통과는 '차단됨'을 쓰지 않는다", () => {
    const other = renderToStaticMarkup(<AttackVerdict outcome="other-reason" expected="NONCE_REUSED" />);
    expect(other).toContain(ATTACK.otherReason("NONCE_REUSED"));
    expect(other).not.toContain(ATTACK.blocked);
    const pass = renderToStaticMarkup(<AttackVerdict outcome="not-blocked" expected="NONCE_REUSED" />);
    expect(pass).toContain(ATTACK.notBlocked);
    expect(pass).not.toContain(ATTACK.confirmed("NONCE_REUSED"));
  });
});
