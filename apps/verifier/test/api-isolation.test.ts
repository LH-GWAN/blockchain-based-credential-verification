/**
 * 불변 조건 §2-5: 검증기관 화면은 발급기관에 직접 조회하지 않는다.
 * - src/lib/api.ts 는 NEXT_PUBLIC_VERIFIER_URL 만 참조한다.
 * - 발급기관 포트(8001/8003)·"issuer" 문자열이 api.ts 에 없다.
 * - fetch 호출은 api.ts 에만 존재한다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const API = join(SRC, "lib", "api.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("api.ts 격리", () => {
  const src = readFileSync(API, "utf8");

  it("NEXT_PUBLIC_VERIFIER_URL 만 참조한다", () => {
    const envs = new Set([...src.matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)].map((m) => m[1]));
    expect([...envs]).toEqual(["NEXT_PUBLIC_VERIFIER_URL"]);
  });

  it("발급기관 포트·issuer 문자열이 없다", () => {
    expect(src).not.toMatch(/8001|8003|issuer/i);
  });

  it("기본 URL 은 검증 서비스(8002)뿐이다", () => {
    const urls = [...src.matchAll(/https?:\/\/[^\s"'`]+/g)].map((m) => m[0]);
    expect(urls).toEqual(["http://localhost:8002"]);
  });
});

describe("src 전체", () => {
  const files = walk(SRC);

  it("fetch 호출은 src/lib/api.ts 에만 있다", () => {
    const offenders = files
      .filter((f) => f !== API)
      .filter((f) => /\bfetch\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("발급기관 포트(8001/8003)·AI(8004) 주소가 어디에도 없다", () => {
    const offenders = files
      .filter((f) => /\b(8001|8003|8004)\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
