#!/usr/bin/env bash
# macOS 에서 .venv 안의 파일에 hidden 플래그가 붙으면 Python 3.12.10+ 가 editable .pth 를 건너뛴다
# ("Skipping hidden .pth file"). uv sync 후 한 번 실행하면 된다. 리눅스에서는 아무 일도 하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" = "Darwin" ] && [ -d .venv ]; then
  chflags -R nohidden .venv 2>/dev/null || true
fi
