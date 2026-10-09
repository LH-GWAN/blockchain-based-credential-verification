/**
 * 문구·프리셋 불변 조건.
 * - 검증기관은 은행·저축은행 창구뿐: 행정복지센터/복지기관 문구가 화면 소스 어디에도 없다.
 * - 내장 프리셋 6개는 서버 /presets(services/verifier config.py PRESETS) 와 같은 ID·항목·정책·취급 창구·창구 자체 확인 항목을 가진다.
 * - 2026 개편: 햇살론뱅크 → 햇살론 일반보증(은행·저축은행), 새희망홀씨는 연소득 4,000만 원 기준·은행 전용.
 * - 신용 하위 20% 고객 프리셋: 연소득 4,500만(햇살론)·5,000만(새희망홀씨) 원 기준, 신용평점은 증명서가 아니라 창구가 조회.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTACK,
  CHECK_LABELS,
  CLAIM_LABELS,
  CRED_CHECK_LABELS,
  ERRORS,
  HEADER,
  policyLabel,
  POLICY_LABELS,
  PRESETS_FALLBACK,
  REASON_KO,
  reasonText,
  REQUEST,
  requestErrorText,
  RESULT,
  RULES_VERSION,
  verifierKindLabel,
} from "../src/lib/copy";
import { CHECK_KEYS } from "../src/lib/types";

const CONFIG_PY = join(__dirname, "..", "..", "..", "services", "verifier", "src", "dbp_verifier", "config.py");

const SRC = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("verifierKindLabel", () => {
  it("bank → 은행, savings → 저축은행, 그 외 → 금융기관", () => {
    expect(verifierKindLabel("bank")).toBe("은행");
    expect(verifierKindLabel("savings")).toBe("저축은행");
    expect(verifierKindLabel("welfare")).toBe("금융기관");
    expect(verifierKindLabel("")).toBe("금융기관");
    expect(verifierKindLabel(undefined)).toBe("금융기관");
  });
});

describe("policyLabel", () => {
  it("알려진 정책은 이름, 모르는 정책은 ID 그대로", () => {
    expect(policyLabel("sunshine-loan-general")).toBe("햇살론 일반보증");
    expect(policyLabel("new-hope-loan")).toBe("새희망홀씨");
    expect(policyLabel("unknown-policy")).toBe("unknown-policy");
  });

  it("폐지된 햇살론뱅크(sunshine-loan-bank) 는 더 이상 등록돼 있지 않다", () => {
    expect(POLICY_LABELS).not.toHaveProperty("sunshine-loan-bank");
  });
});

describe("PRESETS_FALLBACK", () => {
  it("여섯 가지 창구 용도, consult 가 첫 번째 · 신용 하위 20% 프리셋은 각 상품 바로 뒤", () => {
    expect(PRESETS_FALLBACK.map((p) => p.id)).toEqual([
      "consult",
      "sunshine-general",
      "sunshine-general-low-credit",
      "new-hope",
      "new-hope-low-credit",
      "discount",
    ]);
  });

  it("햇살론 일반보증·새희망홀씨(신용 하위 20% 포함)만 정책 판정을 가진다", () => {
    const withPolicy = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.policyId ?? null]));
    expect(withPolicy).toEqual({
      consult: null,
      "sunshine-general": "sunshine-loan-general",
      "sunshine-general-low-credit": "sunshine-loan-general",
      "new-hope": "new-hope-loan",
      "new-hope-low-credit": "new-hope-loan",
      discount: null,
    });
  });

  it("요청 항목: 햇살론 일반보증 3,500만(신용 하위 20%면 4,500만), 새희망홀씨 4,000만(5,000만) 원 이하 1개", () => {
    const requested = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.requested.map((r) => r.claim)]));
    expect(requested).toEqual({
      consult: ["daeguResident", "incomeBelow50Median"],
      "sunshine-general": ["annualIncomeUnder35M"],
      "sunshine-general-low-credit": ["annualIncomeUnder45M"],
      "new-hope": ["annualIncomeUnder40M"],
      "new-hope-low-credit": ["annualIncomeUnder50M"],
      discount: ["incomeBelow50Median"],
    });
  });

  it("취급 창구: 새희망홀씨(신용 하위 20% 포함)만 은행 전용, 나머지는 은행·저축은행", () => {
    const kinds = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.verifierKinds]));
    expect(kinds).toEqual({
      consult: ["bank", "savings"],
      "sunshine-general": ["bank", "savings"],
      "sunshine-general-low-credit": ["bank", "savings"],
      "new-hope": ["bank"],
      "new-hope-low-credit": ["bank"],
      discount: ["bank", "savings"],
    });
  });

  it("창구 자체 확인(counterChecked): 신용 하위 20% 프리셋 둘만, 신용평점 하위 20% = 참", () => {
    const counter = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.counterChecked ?? null]));
    expect(counter).toEqual({
      consult: null,
      "sunshine-general": null,
      "sunshine-general-low-credit": [{ claim: "creditBottom20", expected: true }],
      "new-hope": null,
      "new-hope-low-credit": [{ claim: "creditBottom20", expected: true }],
      discount: null,
    });
  });

  it("창구 자체 확인 항목은 증명서로 요청하지 않는다 (요청 항목과 겹치지 않음)", () => {
    for (const p of PRESETS_FALLBACK) {
      const requested = new Set(p.requested.map((r) => r.claim));
      for (const c of p.counterChecked ?? []) {
        expect(CLAIM_LABELS).toHaveProperty(c.claim);
        expect(requested.has(c.claim), `${p.id}.${c.claim}`).toBe(false);
      }
    }
  });

  it("services/verifier config.py 의 PRESETS 와 문구·항목·취급 창구가 글자 그대로 같다", () => {
    const py = readFileSync(CONFIG_PY, "utf8");
    const presetsPy = py.slice(py.indexOf("PRESETS = ["), py.indexOf("REASON_KO"));
    // 프리셋 하나당 한 덩어리 ({"id": ... 부터 다음 {"id": 앞까지) — 서버 순서와 같다
    const chunks = presetsPy.split(/(?=\{"id": )/).slice(1);
    expect(chunks.map((c) => /"id": "([^"]+)"/.exec(c)?.[1])).toEqual(PRESETS_FALLBACK.map((p) => p.id));
    const pyList = (xs: readonly string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
    PRESETS_FALLBACK.forEach((p, i) => {
      const chunk = chunks[i] ?? "";
      for (const key of ["label", "purpose", "hint"] as const) {
        expect(chunk, `${p.id}.${key}`).toContain(`"${key}": ${JSON.stringify(p[key])}`);
      }
      expect(chunk, `${p.id}.policyId`).toContain(`"policyId": ${p.policyId ? JSON.stringify(p.policyId) : "None"}`);
      expect(chunk, `${p.id}.verifierKinds`).toContain(`"verifierKinds": ${pyList(p.verifierKinds ?? [])}`);
      const pyItems = (xs: readonly { claim: string; expected: boolean }[]) =>
        `[${xs.map((r) => `{"claim": ${JSON.stringify(r.claim)}, "expected": ${r.expected ? "True" : "False"}}`).join(", ")}]`;
      expect(chunk, `${p.id}.requested`).toContain(`"requested": ${pyItems(p.requested)}`);
      // counterChecked: 있으면 글자 그대로 같고, 없으면 서버 쪽에도 키가 없다
      if (p.counterChecked) expect(chunk, `${p.id}.counterChecked`).toContain(`"counterChecked": ${pyItems(p.counterChecked)}`);
      else expect(chunk, `${p.id}.counterChecked`).not.toContain(`"counterChecked"`);
      // 서버 프리셋의 최상위 키 = 내장 사본의 키 (새 필드가 생기면 여기서 걸린다). claim·expected 는 항목 안쪽 키.
      const pyKeys = new Set([...chunk.matchAll(/"(\w+)": /g)].map((m) => m[1]));
      pyKeys.delete("claim");
      pyKeys.delete("expected");
      expect([...pyKeys].sort(), `${p.id} keys`).toEqual(Object.keys(p).sort());
    });
  });

  it("문구: 햇살론 일반보증 라벨·용도, 햇살론뱅크 언급 없음", () => {
    const sunshine = PRESETS_FALLBACK.find((p) => p.id === "sunshine-general");
    expect(sunshine?.label).toBe("햇살론 일반보증 대상 확인");
    expect(sunshine?.purpose).toBe("햇살론 일반보증 대상 확인");
    for (const p of PRESETS_FALLBACK) expect(JSON.stringify(p)).not.toMatch(/햇살론뱅크|햇살론 ?뱅크/);
  });

  it("공공요금 감면 안내문은 비교 패널과 같은 서류(소득금액증명·등본) 기준 — 수급자증명서 언급 없음 (F48)", () => {
    const discount = PRESETS_FALLBACK.find((p) => p.id === "discount");
    expect(discount?.hint).toBe(
      "전기·도시가스·통신 요금 감면 창구가 소득금액증명·주민등록표 등본 원본 대신 '기준 중위소득 50% 이하 = 참' 1개 항목만 받습니다.",
    );
    expect(discount?.hint).not.toContain("수급자증명서");
  });

  it("요청 항목은 모두 알려진 claim 이고 기대값은 참", () => {
    for (const p of PRESETS_FALLBACK) {
      expect(p.requested.length).toBeGreaterThan(0);
      for (const r of p.requested) {
        expect(CLAIM_LABELS).toHaveProperty(r.claim);
        expect(r.expected).toBe(true);
      }
      expect(p.hint.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.purpose.length).toBeGreaterThan(0);
    }
  });
});

describe("CLAIM_LABELS", () => {
  it("새 소득 구간 항목(4,000만·5,000만 원)의 라벨이 규칙 묶음과 같다", () => {
    expect(CLAIM_LABELS.annualIncomeUnder35M).toBe("연소득 3,500만 원 이하 여부");
    expect(CLAIM_LABELS.annualIncomeUnder40M).toBe("연소득 4,000만 원 이하 여부");
    expect(CLAIM_LABELS.annualIncomeUnder50M).toBe("연소득 5,000만 원 이하 여부");
  });
});

describe("정책 판정 보조 문구", () => {
  it("판정 불가 사유와 창구 자체 확인 문구", () => {
    expect(RESULT.policyPending("기초생활보장 급여 수급 여부")).toBe(
      "판정에 필요한 항목이 제출되지 않았습니다: 기초생활보장 급여 수급 여부",
    );
    expect(RESULT.policyCounterChecked("신용평점 하위 20%")).toBe("창구 자체 확인: 신용평점 하위 20%");
    expect(REQUEST.presetCounterChecked("신용평점 하위 20%")).toBe("창구가 먼저 확인: 신용평점 하위 20%");
  });

  it("규칙 안내: 창구 확인값이 들어갔으면 '신용평점은 포함하지 않음'이라고 적지 않는다", () => {
    expect(RESULT.policyRuleNote()).toBe(
      `규칙 ${RULES_VERSION}, 제출된 항목만으로 계산 — 재직·신용평점 등 창구 심사 요건은 포함하지 않음`,
    );
    const withCounter = RESULT.policyRuleNote(true);
    expect(withCounter).toBe(
      `규칙 ${RULES_VERSION}, 제출된 항목과 창구 확인값만으로 계산 — 재직 등 그 밖의 창구 심사 요건은 포함하지 않음`,
    );
    expect(withCounter).not.toContain("신용평점");
  });
});

describe("검증 단계 체크리스트 (F32)", () => {
  it("11개 단계 — 발급기관 활성·발급 권한·증명서 유효기간이 따로 보인다", () => {
    expect(CHECK_KEYS).toHaveLength(11);
    for (const k of ["issuerActive", "issuerAuthoritative", "notExpired"] as const) expect(CHECK_KEYS).toContain(k);
    expect(Object.keys(CHECK_LABELS).sort()).toEqual([...CHECK_KEYS].sort());
    for (const k of CHECK_KEYS) expect(CHECK_LABELS[k].length, k).toBeGreaterThan(0);
  });

  it("증명서별 확인 키(verify.py) 라벨: 유효기간·발급 권한 포함", () => {
    for (const k of ["issuerRegistered", "issuerActive", "issuerAuthoritative", "signature", "notExpired", "holderBinding", "notRevoked", "ruleVersion"]) {
      expect(CRED_CHECK_LABELS, k).toHaveProperty(k);
    }
  });
});

describe("REASON_KO", () => {
  it("새 사유 코드 문구 (검증 서비스·지갑과 같은 문구)", () => {
    expect(REASON_KO).toMatchObject({
      ISSUER_NOT_AUTHORITATIVE: "이 항목을 발급할 권한이 없는 기관의 증명서입니다",
      UNREQUESTED_CREDENTIAL: "요청하지 않은 증명서가 함께 제출되었습니다",
      LEDGER_UNAVAILABLE: "공동원장에 연결할 수 없습니다 — 잠시 후 다시 시도하세요",
      RULE_VERSION_NOT_ACCEPTED: "이 창구가 받지 않는 규칙 버전입니다",
      STATUS_LIST_OWNER_MISMATCH: "상태 목록 게시자가 발급기관과 다릅니다",
      REQUESTED_INVALID: "요청 항목이 올바르지 않습니다",
      TOO_MANY_LOOKUPS: "확인번호 조회가 너무 많습니다 — 잠시 후 다시 시도하세요",
      RESULT_AUTH_REQUIRED: "이 결과를 볼 권한이 없습니다",
      RESULT_FORBIDDEN: "이 결과를 볼 권한이 없습니다",
    });
    expect(ERRORS.resultForbidden).toBe(REASON_KO.RESULT_FORBIDDEN);
  });

  it("services/verifier config.py 의 REASON_KO 와 같은 코드는 글자 그대로 같은 문구", () => {
    const py = readFileSync(CONFIG_PY, "utf8");
    const block = py.slice(py.indexOf("REASON_KO = {"), py.indexOf("\n}", py.indexOf("REASON_KO = {")));
    const pyReasons = Object.fromEntries([...block.matchAll(/"([A-Z_]+)": "([^"]*)"/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(pyReasons).length).toBeGreaterThan(15);
    // 서버가 내는 사유 코드는 모두 화면 폴백에도 있어야 한다 (응답 reasons 가 빠졌을 때 코드가 그대로 보이지 않게)
    for (const [code, text] of Object.entries(pyReasons)) expect(REASON_KO[code], code).toBe(text);
  });

  it("요청 생성 실패 REQUESTED_INVALID 는 한국어로, 서버 문구가 있으면 서버 문구 우선", () => {
    expect(requestErrorText("REQUESTED_INVALID")).toBe("요청 항목이 올바르지 않습니다");
    expect(reasonText("LEDGER_UNAVAILABLE")).toBe("공동원장에 연결할 수 없습니다 — 잠시 후 다시 시도하세요");
    expect(reasonText("LEDGER_UNAVAILABLE", "서버 문구")).toBe("서버 문구");
  });
});

describe("공격 시연 문구 (F26·F29)", () => {
  it("예상과 다른 사유로 거부된 경우는 '차단됨'·'… 확인' 문구를 쓰지 않는다 (E2E 가 두 경우를 구분)", () => {
    for (const meta of Object.values(ATTACK.kinds)) {
      const other = ATTACK.otherReason(meta.expected);
      expect(other).not.toContain(ATTACK.blocked);
      expect(other).not.toContain(ATTACK.confirmed(meta.expected));
      expect(ATTACK.confirmed(meta.expected)).toBe(`· ${meta.expected} 확인`);
    }
    expect(ATTACK.notBlocked).not.toContain(ATTACK.blocked);
  });
});

describe("requestErrorText", () => {
  it("PRESET_NOT_OFFERED 는 한국어 문구로", () => {
    expect(requestErrorText("PRESET_NOT_OFFERED")).toBe("이 창구에서 취급하지 않는 상품입니다");
  });

  it("모르는 코드는 코드를 붙인 일반 오류", () => {
    expect(requestErrorText("VERIFIER_UNKNOWN")).toBe(ERRORS.generic("VERIFIER_UNKNOWN"));
    expect(requestErrorText("HTTP_500")).toBe("오류가 발생했습니다 (HTTP_500)");
  });
});

describe("문구", () => {
  it("헤더: 발급기관 비조회 문구 유지 + 참/거짓 항목 문구 추가", () => {
    expect(HEADER.subtitle).toBe("발급기관에 직접 조회하지 않습니다 · 공동원장만 확인");
    expect(HEADER.tagline).toBe("소득금액증명 원본 대신 참/거짓 항목만 받습니다");
  });

  it("행정복지센터·복지기관·행정기관을 검증기관으로 언급하지 않는다", () => {
    const offenders = walk(SRC)
      .filter((f) => /행정복지센터|복지기관|행정기관/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});



describe("§2-9 과장 금지 · §1.1 폐기 주장 금지", () => {
  it("src/ 어디에도 '유출 불가', '개인정보가 사라진다', '종이 증명서를 없앤다' 류 문구가 없다", () => {
    const banned = [/유출(이)? ?불가/, /개인정보가 사라/, /종이 ?증명서를 ?없/, /행정기관 사이에서만/];
    for (const p of walk(join(process.cwd(), "src"))) {
      const text = readFileSync(p, "utf-8");
      for (const re of banned) expect(text, `${p} contains ${re}`).not.toMatch(re);
    }
  });
});
