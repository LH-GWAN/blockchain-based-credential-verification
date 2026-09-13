#!/usr/bin/env bash
# 로컬 시연 스택 기동 (Docker 없이): Hardhat 체인 → 배포·시드 → 발급기관 2 → 검증기관 → AI → 지갑·검증기관 앱
# 종료: Ctrl+C (모든 자식 프로세스 정리)
set -euo pipefail
cd "$(dirname "$0")/.."
export RULE_EVAL_DATE="${RULE_EVAL_DATE:-2026-09-14}"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
mkdir -p .demo
PIDS=()
cleanup() { echo; echo "[demo] 종료 중…"; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

wait_http() { local url=$1 n=0; until curl -sf "$url" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 60 ] && { echo "[demo] $url 응답 없음"; exit 1; }; sleep 1; done; }
wait_rpc() { local n=0; until curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 60 ] && { echo "[demo] 체인 응답 없음"; exit 1; }; sleep 1; done; }

if curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null 2>&1; then
  echo "[demo] 체인이 이미 떠 있음: $RPC_URL"
else
  echo "[demo] Hardhat 체인 기동"
  (pnpm --filter @dbp/chain node > .demo/chain.log 2>&1) & PIDS+=($!)
  wait_rpc
fi
echo "[demo] 컨트랙트 배포 + 원장 시드"
pnpm --filter @dbp/chain deploy:localhost > .demo/deploy.log 2>&1
uv run python scripts/seed_ledger.py | tail -3

echo "[demo] 발급기관(대구시 8001, iM뱅크 8003) · 검증기관(8002) · AI(8004) 기동"
(ISSUER_ID=daegu ISSUER_PORT=8001 ISSUER_DB_PATH=.demo/issuer-daegu.db uv run python -m dbp_issuer > .demo/issuer-daegu.log 2>&1) & PIDS+=($!)
(ISSUER_ID=imbank ISSUER_PORT=8003 ISSUER_DB_PATH=.demo/issuer-imbank.db uv run python -m dbp_issuer > .demo/issuer-imbank.log 2>&1) & PIDS+=($!)
(VERIFIER_PORT=8002 uv run python -m dbp_verifier > .demo/verifier.log 2>&1) & PIDS+=($!)
(AI_PORT=8004 uv run python -m dbp_ai > .demo/ai.log 2>&1) & PIDS+=($!)
wait_http http://localhost:8001/health; wait_http http://localhost:8003/health; wait_http http://localhost:8002/health; wait_http http://localhost:8004/health

echo "[demo] 지갑 앱(3000) · 검증기관 앱(3001) 기동"
(pnpm --filter @dbp/wallet dev -- -p 3000 > .demo/wallet.log 2>&1) & PIDS+=($!)
(pnpm --filter @dbp/verifier-app dev -- -p 3001 > .demo/verifier-app.log 2>&1) & PIDS+=($!)
wait_http http://localhost:3000; wait_http http://localhost:3001

cat <<MSG

  ✅ 시연 준비 완료
     시민 지갑       http://localhost:3000
     검증기관 화면   http://localhost:3001
     발급기관 관리   http://localhost:8001/docs  (대구시)  ·  http://localhost:8003/docs (iM뱅크)
     로그            .demo/*.log
  docs/DEMO.md 의 ①~⑤ 순서대로 진행하세요. 종료: Ctrl+C

MSG
wait
