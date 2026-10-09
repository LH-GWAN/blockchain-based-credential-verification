/**
 * 문구·프리셋 불변 조건.
 * - 검증기관은 은행·저축은행 창구뿐: 행정복지센터/복지기관 문구가 화면 소스 어디에도 없다.
 * - 내장 프리셋 4개는 서버 /presets(services/verifier config.py PRESETS) 와 같은 ID·항목·정책·취급 창구를 가진다.
 * - 2026 개편: 햇살론뱅크 → 햇살론 일반보증(은행·저축은행), 새희망홀씨는 연소득 4,000만 원 기준·은행 전용.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAIM_LABELS,
  ERRORS,
  HEADER,
  policyLabel,
  POLICY_LABELS,
  PRESETS_FALLBACK,
  requestErrorText,
  verifierKindLabel,
} from "../src/lib/copy";

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
  it("네 가지 창구 용도, consult 가 첫 번째", () => {
    expect(PRESETS_FALLBACK.map((p) => p.id)).toEqual(["consult", "sunshine-general", "new-hope", "discount"]);
  });

  it("햇살론 일반보증·새희망홀씨만 정책 판정을 가진다", () => {
    const withPolicy = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.policyId ?? null]));
    expect(withPolicy).toEqual({
      consult: null,
      "sunshine-general": "sunshine-loan-general",
      "new-hope": "new-hope-loan",
      discount: null,
    });
  });

  it("요청 항목: 햇살론 일반보증은 연소득 3,500만 원, 새희망홀씨는 연소득 4,000만 원 이하 1개", () => {
    const requested = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.requested.map((r) => r.claim)]));
    expect(requested).toEqual({
      consult: ["daeguResident", "incomeBelow50Median"],
      "sunshine-general": ["annualIncomeUnder35M"],
      "new-hope": ["annualIncomeUnder40M"],
      discount: ["incomeBelow50Median"],
    });
  });

  it("취급 창구: 새희망홀씨만 은행 전용, 나머지는 은행·저축은행", () => {
    const kinds = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.verifierKinds]));
    expect(kinds).toEqual({
      consult: ["bank", "savings"],
      "sunshine-general": ["bank", "savings"],
      "new-hope": ["bank"],
      discount: ["bank", "savings"],
    });
  });

  it("services/verifier config.py 의 PRESETS 와 문구·항목·취급 창구가 글자 그대로 같다", () => {
    const py = readFileSync(join(__dirname, "..", "..", "..", "services", "verifier", "src", "dbp_verifier", "config.py"), "utf8");
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
      const req = p.requested.map((r) => `{"claim": ${JSON.stringify(r.claim)}, "expected": ${r.expected ? "True" : "False"}}`);
      expect(chunk, `${p.id}.requested`).toContain(`"requested": [${req.join(", ")}]`);
    });
  });

  it("문구: 햇살론 일반보증 라벨·용도, 햇살론뱅크 언급 없음", () => {
    const sunshine = PRESETS_FALLBACK.find((p) => p.id === "sunshine-general");
    expect(sunshine?.label).toBe("햇살론 일반보증 대상 확인");
    expect(sunshine?.purpose).toBe("햇살론 일반보증 대상 확인");
    for (const p of PRESETS_FALLBACK) expect(JSON.stringify(p)).not.toMatch(/햇살론뱅크|햇살론 ?뱅크/);
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
