// data/citizens.json (합성 시민 30명) → src/generated/citizens.json
// 원본 프로필은 시민 본인 단말(지갑)과 발급기관 시드 DB 에만 존재한다. 이 복사본은 지갑 번들에만 들어간다.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../data/citizens.json');
const dstDir = resolve(here, '../src/generated');
const dst = resolve(dstDir, 'citizens.json');

if (!existsSync(src)) {
  console.error(`[sync-data] not found: ${src}`);
  process.exit(1);
}
const parsed = JSON.parse(readFileSync(src, 'utf-8'));
if (!Array.isArray(parsed.citizens) || parsed.citizens.length === 0) {
  console.error('[sync-data] citizens.json has no "citizens" array');
  process.exit(1);
}
mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log(`[sync-data] ${parsed.citizens.length} citizens → src/generated/citizens.json`);
