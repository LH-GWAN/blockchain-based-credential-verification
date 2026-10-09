#!/usr/bin/env bash
# compose 기동 상태에서 `make demo-isolation` 출력을 텍스트+PNG 로 캡처 → docs/screenshots/17-isolation-terminal.{txt,png}
# 임시 파일(.demo/)에 먼저 만들고, 프로브·PNG 생성이 모두 성공했을 때만 txt·png 를 함께 바꾼다 (서로 다른 실행 결과가 섞이지 않게).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .demo docs/screenshots
OUT_TXT=docs/screenshots/17-isolation-terminal.txt
OUT_PNG=docs/screenshots/17-isolation-terminal.png
TMP_TXT=.demo/isolation.txt
TMP_PNG=.demo/isolation.png
rm -f "$TMP_TXT" "$TMP_PNG"
{
  echo "\$ docker compose ps --format 'table {{.Service}}\t{{.State}}'"
  docker compose ps --format 'table {{.Service}}\t{{.State}}' 2>&1
  echo
  echo "\$ make demo-isolation"
  make demo-isolation 2>&1
} | tee "$TMP_TXT"
python3 - "$TMP_TXT" <<'PY'
import html, pathlib, sys
txt = pathlib.Path(sys.argv[1]).read_text()
page = f"""<!doctype html><meta charset="utf-8"><title>isolation</title>
<style>body{{margin:0;background:#0f172a}} pre{{margin:0;padding:28px 32px;color:#e2e8f0;font:15px/1.5 'SF Mono',Menlo,monospace;white-space:pre-wrap}}
.h{{color:#94a3b8}} .ok{{color:#4ade80;font-weight:700}} .no{{color:#f87171;font-weight:700}}</style>
<pre>{html.escape(txt).replace('✅','<span class=ok>✅</span>').replace('차단됨','<span class=ok>차단됨</span>').replace('❌','<span class=no>❌</span>')}</pre>"""
pathlib.Path(".demo/isolation.html").write_text(page)
PY
pnpm --filter @dbp/e2e exec playwright screenshot --viewport-size=1100,600 --full-page "file://$PWD/.demo/isolation.html" "$PWD/$TMP_PNG"
mv "$TMP_TXT" "$OUT_TXT"
mv "$TMP_PNG" "$OUT_PNG"
echo "saved $OUT_TXT · $OUT_PNG"
