/**
 * 개인정보 불변 조건 (프롬프트 §2-2, §2-6) 을 지갑 코드에서 강제한다.
 *  1. AI 페이로드에는 범주값 6개 + ruleResults 만 들어간다 (C-001 김복례로 확인).
 *  2. 모든 네트워크 호출은 src/lib/api.ts 를 통해서만 나간다.
 *  3. api.ts 는 원본 프로필 필드를 알지 못하고, POST 경로는 허용 목록뿐이다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadBundle } from '@dbp/rules/node';
import { describe, expect, it } from 'vitest';
import { buildRecommendPayload, getCitizen } from '@/lib/eligibility';

const SRC = resolve(__dirname, '../src');
const API = resolve(SRC, 'lib/api.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('AI 페이로드 allowlist', () => {
  const bundle = loadBundle();
  const c001 = getCitizen('C-001');

  it('C-001 프로필은 합성 데이터 기대값과 같다', () => {
    expect(c001).toBeDefined();
    expect(c001?.name).toBe('김복례');
    expect(c001?.monthlyIncomeKRW).toBe(1000000);
  });

  it('페이로드에는 범주값 6개 + ruleResults + locale 만 있다', () => {
    const payload = buildRecommendPayload(bundle, c001!);
    expect(Object.keys(payload).sort()).toEqual(['categoricalProfile', 'locale', 'ruleResults']);
    expect(Object.keys(payload.categoricalProfile).sort()).toEqual(
      ['ageBand', 'creditTier', 'householdSize', 'incomeBracket', 'recipientStatus', 'residence'].sort(),
    );
    expect(payload.categoricalProfile).toEqual({
      ageBand: '65+',
      householdSize: 1,
      residence: 'daegu',
      incomeBracket: '≤48%',
      recipientStatus: 'near-poor',
      creditTier: 'bottom20',
    });
    for (const r of payload.ruleResults) {
      expect(Object.keys(r).sort()).toEqual(['eligible', 'matchedClaims', 'policyId']);
      expect(typeof r.eligible).toBe('boolean');
    }
  });

  it('페이로드 JSON 에 원본 필드·수치·이름이 없다', () => {
    const json = JSON.stringify(buildRecommendPayload(bundle, c001!));
    for (const forbidden of ['monthlyIncomeKRW', 'annualIncomeKRW', 'birthDate', 'name', '1000000', '김복례', '1958', '북구', 'sigungu', 'residence.sido']) {
      expect(json, `forbidden token: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('ruleResults 는 규칙 엔진 판정과 일치한다 (김복례: 주거급여·차상위·기초연금 적격, 생계급여·교육급여 부적격)', () => {
    const payload = buildRecommendPayload(bundle, c001!);
    const byId = Object.fromEntries(payload.ruleResults.map((r) => [r.policyId, r]));
    expect(byId['nbl-housing']?.eligible).toBe(true);
    expect(byId['near-poor']?.eligible).toBe(true);
    expect(byId['basic-pension']?.eligible).toBe(true);
    expect(byId['micro-livelihood-loan']?.eligible).toBe(true);
    expect(byId['nbl-livelihood']?.eligible).toBe(false);
    expect(byId['nbl-education']?.eligible).toBe(false);
    expect(byId['near-poor']?.matchedClaims).toEqual(['incomeBelow50Median']);
  });
});

describe('네트워크 호출은 api.ts 한 곳으로만', () => {
  const files = walk(SRC);

  it('fetch( 는 src/lib/api.ts 에만 등장한다', () => {
    const offenders = files.filter((f) => f !== API && /\bfetch\s*\(/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('XMLHttpRequest / EventSource / WebSocket / navigator.sendBeacon 을 직접 쓰지 않는다', () => {
    const offenders = files.filter((f) => /\b(XMLHttpRequest|EventSource|WebSocket|sendBeacon)\b/.test(readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('api.ts 는 원본 프로필 필드명을 참조하지 않는다', () => {
    const src = readFileSync(API, 'utf-8');
    for (const forbidden of [
      'monthlyIncomeKRW',
      'annualIncomeKRW',
      'birthDate',
      'isBasicLivelihoodRecipient',
      'hasStudentChild',
      'creditScoreTier',
      'householdSize',
      'sigungu',
      'CitizenProfile',
      'citizens.json',
      'privateKey',
    ]) {
      expect(src, `api.ts must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('POST 경로는 허용 목록(challenge/issue/recommend/chat/chat-complete/present) 뿐이다', () => {
    const src = readFileSync(API, 'utf-8');
    const paths = new Set<string>();
    // postJson<T>(`${base}/path`, body) 와 스트리밍용 fetch(url) 의 url 정의 모두 수집
    for (const m of src.matchAll(/postJson<[^(]*>\(\s*`\$\{[^}]+\}([^`]*)`/g)) paths.add(m[1] as string);
    for (const m of src.matchAll(/const url = `\$\{[^}]+\}([^`]*)`/g)) paths.add(m[1] as string);
    expect([...paths].sort()).toEqual(['/chat', '/chat/complete', '/credentials/challenge', '/credentials/issue', '/present', '/recommend']);
    // fetch 호출 수 = getJson/postJson 공용 request 1 + 스트리밍 1
    expect((src.match(/\bfetch\s*\(/g) ?? []).length).toBe(2);
  });
  it('DELETE 는 AI 상담 세션 삭제 하나뿐이고 본문이 없다 (F20)', () => {
    const src = readFileSync(API, 'utf-8');
    const deletes = [...src.matchAll(/request<[^>]*>\(\s*`([^`]*)`,\s*\{([^}]*)\}/g)].filter((m) => /method:\s*'DELETE'/.test(m[2] as string));
    expect(deletes.map((m) => (m[1] as string).replace(/\$\{[^}]+\}/g, '*'))).toEqual(['*/chat/*']);
    expect(deletes[0]![2]).not.toContain('body');
  });

  it('AI 감사 기록은 기록 번호로만 본다 — 프로세스 전체의 마지막 호출(last-payload)을 부르지 않는다 (F12)', () => {
    const files = walk(SRC);
    const offenders = files.filter((f) => readFileSync(f, 'utf-8').includes('last-payload'));
    expect(offenders).toEqual([]);
  });
});
