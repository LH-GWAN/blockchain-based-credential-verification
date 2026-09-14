#!/usr/bin/env bash
# compose 기동 상태에서 `make demo-isolation` 출력을 텍스트+PNG 로 캡처 → docs/screenshots/17-isolation-terminal.{txt,png}
set -euo pipefail
cd "$(dirname "$0")/.."
OUT_TXT=docs/screenshots/17-isolation-terminal.txt
{
  echo "\$ docker compose ps --format 'table {{.Service}}\t{{.State}}'"
  docker compose ps --format 'table {{.Service}}\t{{.State}}' 2>&1
  echo
  echo "\$ make demo-isolation"
  make demo-isolation 2>&1
} | tee "$OUT_TXT"
python3 - "$OUT_TXT" <<'PY'
import html, pathlib, sys
txt = pathlib.Path(sys.argv[1]).read_text()
page = f"""<!doctype html><meta charset="utf-8"><title>isolation</title>
<style>body{{margin:0;background:#0f172a}} pre{{margin:0;padding:28px 32px;color:#e2e8f0;font:15px/1.5 'SF Mono',Menlo,monospace;white-space:pre-wrap}}
.h{{color:#94a3b8}} .ok{{color:#4ade80;font-weight:700}} .no{{color:#f87171;font-weight:700}}</style>
<pre>{html.escape(txt).replace('✅','<span class=ok>✅</span>').replace('차단됨','<span class=ok>차단됨</span>').replace('Connection refused','<span class=no>Connection refused</span>').replace('Name or service not known','<span class=no>Name or service not known</span>')}</pre>"""
pathlib.Path(".demo/isolation.html").write_text(page)
PY
pnpm --filter @dbp/e2e exec playwright screenshot --viewport-size=1100,700 --full-page "file://$PWD/.demo/isolation.html" docs/screenshots/17-isolation-terminal.png
echo "saved docs/screenshots/17-isolation-terminal.png"
