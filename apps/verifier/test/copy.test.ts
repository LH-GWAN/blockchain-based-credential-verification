/**
 * 문구·프리셋 불변 조건.
 * - 검증기관은 은행·저축은행 창구뿐: 행정복지센터/복지기관 문구가 화면 소스 어디에도 없다.
 * - 내장 프리셋 4개는 서버 /presets 와 같은 ID·항목을 가진다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIM_LABELS, HEADER, policyLabel, PRESETS_FALLBACK, verifierKindLabel } from "../src/lib/copy";

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
    expect(policyLabel("sunshine-loan-bank")).toBe("햇살론뱅크");
    expect(policyLabel("new-hope-loan")).toBe("새희망홀씨");
    expect(policyLabel("unknown-policy")).toBe("unknown-policy");
  });
});

describe("PRESETS_FALLBACK", () => {
  it("네 가지 창구 용도, consult 가 첫 번째", () => {
    expect(PRESETS_FALLBACK.map((p) => p.id)).toEqual(["consult", "sunshine-bank", "new-hope", "discount"]);
  });

  it("햇살론뱅크·새희망홀씨만 정책 판정을 가진다", () => {
    const withPolicy = Object.fromEntries(PRESETS_FALLBACK.map((p) => [p.id, p.policyId ?? null]));
    expect(withPolicy).toEqual({
      consult: null,
      "sunshine-bank": "sunshine-loan-bank",
      "new-hope": "new-hope-loan",
      discount: null,
    });
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
