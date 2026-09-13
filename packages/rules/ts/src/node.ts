/** Node 전용 로더 ('@dbp/rules/node'). 브라우저 번들에는 포함하지 않는다. 코어 API 도 함께 재수출한다. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBundle } from './bundle.js';
import { DEFAULT_EVAL_DATE } from './engine.js';
import type { PolicyMeta } from './policies.js';
import type { Bundle, CitizenProfile } from './types.js';

export * from './index.js';

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

/** 환경변수 DBP_REPO_ROOT 또는 pnpm-workspace.yaml 을 찾아 올라간다 (Python paths.repo_root). */
export function repoRoot(): string {
  const env = process.env['DBP_REPO_ROOT'];
  if (env) return resolve(env);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found (set DBP_REPO_ROOT)');
    dir = parent;
  }
}

export function loadBundle(root?: string, bundle = 'daegu-eligibility', version = '2026.1'): Bundle {
  const r = root ?? repoRoot();
  const base = join(r, 'packages/rules/bundles', bundle, version);
  return composeBundle(
    bundle,
    version,
    readJson(join(base, 'preprocess.json')),
    readJson(join(base, 'claims.json')),
    readJson(join(base, 'policies.json')),
    readJson(join(r, 'data/median-income-2026.json')),
  );
}

/** data/policies/*.json 을 파일명 순으로 (Python `sorted(glob)`). */
export function loadPolicies(root?: string): PolicyMeta[] {
  const dir = join(root ?? repoRoot(), 'data/policies');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .map((f) => readJson<PolicyMeta>(join(dir, f)));
}

export function loadCitizens(root?: string): CitizenProfile[] {
  return readJson<{ citizens: CitizenProfile[] }>(join(root ?? repoRoot(), 'data/citizens.json')).citizens;
}

/** 기준일: 번들의 evalDateEnv(기본 RULE_EVAL_DATE) 환경변수 또는 DEFAULT_EVAL_DATE (Python eval_date_from_env). */
export function evalDateFromEnv(bundle: Bundle): string {
  return process.env[bundle.preprocess.evalDateEnv ?? 'RULE_EVAL_DATE'] ?? DEFAULT_EVAL_DATE;
}
