#!/usr/bin/env bash
# 로컬 시연 스택 기동 (Docker 없이): Hardhat 체인 → 배포·시드 → 발급기관 2 → 검증기관 → AI → 지갑·검증기관 앱
# 종료: Ctrl+C (모든 자식 프로세스 정리)
# ⑦ 이후 발급기관만 다시 띄우기: ./scripts/demo.sh issuers  (= make demo-issuers, 같은 포트·DB 로 기동)
set -euo pipefail
cd "$(dirname "$0")/.."
export RULE_EVAL_DATE="${RULE_EVAL_DATE:-2026-09-14}"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
./scripts/fix_venv.sh
mkdir -p .demo
PIDS=()
cleanup() { echo; echo "[demo] 종료 중…"; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
# 포트를 이미 다른 프로세스(리허설에서 남은 발급기관 등)가 잡고 있으면 새 프로세스는 bind 에 실패하고,
# 헬스 체크는 남은 프로세스의 응답으로 통과해 버린다 → 이전 배포 주소로 폐기를 게시하는 사고를 막기 위해 먼저 멈춘다.
require_free() {
  local port=$1 what=$2
  port_free "$port" && return 0
  echo "[demo] 포트 $port($what)를 이미 다른 프로세스가 사용 중입니다 — 정리한 뒤 다시 실행하세요:"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
  echo "       예: pkill -f dbp_issuer ; pkill -f dbp_verifier ; pkill -f dbp_ai"
  exit 1
}
# 새로 띄운 프로세스($2)가 살아 있는 채로 응답해야 준비 완료로 본다
wait_http() {
  local url=$1 pid=${2:-} n=0
  until curl -sf "$url" >/dev/null 2>&1; do
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "[demo] $url 프로세스가 종료됨 — .demo/*.log 확인"; exit 1; fi
    n=$((n+1)); [ $n -gt 60 ] && { echo "[demo] $url 응답 없음"; exit 1; }; sleep 1
  done
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "[demo] $url 프로세스가 종료됨 — .demo/*.log 확인"; exit 1; fi
}
wait_rpc() { local n=0; until curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 60 ] && { echo "[demo] 체인 응답 없음"; exit 1; }; sleep 1; done; }

# 발급기관 2곳 (대구시 8001, 복지기관 8003). DB 는 .demo/ 아래 — 재기동해도 발급 기록(폐기 대상 jti)이 이어진다.
start_issuers() {
  require_free 8001 "대구시 발급기관"; require_free 8003 "복지기관 발급기관"
  (ISSUER_ID=daegu ISSUER_PORT=8001 ISSUER_DB_PATH=.demo/issuer-daegu.db uv run python -m dbp_issuer >> .demo/issuer-daegu.log 2>&1) & PIDS+=($!); P_DAEGU=$!
  (ISSUER_ID=welfare ISSUER_PORT=8003 ISSUER_DB_PATH=.demo/issuer-welfare.db uv run python -m dbp_issuer >> .demo/issuer-welfare.log 2>&1) & PIDS+=($!); P_WELFARE=$!
}
wait_issuers() { wait_http http://127.0.0.1:8001/health "$P_DAEGU"; wait_http http://127.0.0.1:8003/health "$P_WELFARE"; }

if [ "${1:-}" = "issuers" ]; then
  echo "[demo] 발급기관 재기동 (대구시 8001, 복지기관 8003) — 체인·검증기관·앱은 그대로 둔다"
  start_issuers; wait_issuers
  echo "[demo] 발급기관 준비 완료. 종료: Ctrl+C"
  wait
  exit 0
fi

# 서비스 포트를 먼저 확인한다 (체인 배포 전에 멈춰야 남은 프로세스와 주소가 어긋나지 않는다)
require_free 8001 "대구시 발급기관"; require_free 8002 "검증기관"; require_free 8003 "복지기관 발급기관"; require_free 8004 "AI"

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
# 지갑이 원장을 직접 읽을 컨트랙트 주소 (F40): 빌드 설정으로 넘기면 지갑이 발급기관에 배포 정보를 묻지 않고,
# 체인을 재배포해도 단말에 남은 이전 주소 대신 이번 배포 주소를 쓴다.
eval "$(uv run python - <<'PY'
import json, shlex
c = json.load(open("chain/deployments/latest.json", encoding="utf-8"))["contracts"]
for env, name in [("RULE_REGISTRY", "RuleRegistry"), ("STATUS_LIST_REGISTRY", "StatusListRegistry"), ("RECEIPT_ANCHOR", "ReceiptAnchor")]:
    print(f"export NEXT_PUBLIC_{env}_ADDRESS={shlex.quote(c[name]['address'])}")
PY
)"

echo "[demo] 발급기관(대구시 8001, 복지기관 8003) · 검증기관(8002) · AI(8004) 기동"
: > .demo/issuer-daegu.log; : > .demo/issuer-welfare.log
start_issuers
(VERIFIER_PORT=8002 uv run python -m dbp_verifier > .demo/verifier.log 2>&1) & PIDS+=($!); P_VERIFIER=$!
(AI_PORT=8004 uv run python -m dbp_ai > .demo/ai.log 2>&1) & PIDS+=($!); P_AI=$!
wait_issuers; wait_http http://127.0.0.1:8002/health "$P_VERIFIER"; wait_http http://127.0.0.1:8004/health "$P_AI"

WALLET_PORT="${WALLET_PORT:-3000}"; port_free "$WALLET_PORT" || { echo "[demo] $WALLET_PORT 포트 사용 중 → 지갑을 3010 으로 기동"; WALLET_PORT=3010; }
VERIFIER_APP_PORT="${VERIFIER_APP_PORT:-3001}"; port_free "$VERIFIER_APP_PORT" || { echo "[demo] $VERIFIER_APP_PORT 포트 사용 중 → 검증기관 화면을 3011 로 기동"; VERIFIER_APP_PORT=3011; }
require_free "$WALLET_PORT" "지갑 앱"; require_free "$VERIFIER_APP_PORT" "검증기관 앱"
echo "[demo] 지갑 앱($WALLET_PORT) · 검증기관 앱($VERIFIER_APP_PORT) 기동"
(pnpm --filter @dbp/wallet dev -p "$WALLET_PORT" > .demo/wallet.log 2>&1) & PIDS+=($!); P_WALLET=$!
(pnpm --filter @dbp/verifier-app dev -p "$VERIFIER_APP_PORT" > .demo/verifier-app.log 2>&1) & PIDS+=($!); P_VAPP=$!
wait_http "http://localhost:$WALLET_PORT" "$P_WALLET"; wait_http "http://localhost:$VERIFIER_APP_PORT" "$P_VAPP"
echo "http://localhost:$WALLET_PORT" > .demo/wallet.url; echo "http://localhost:$VERIFIER_APP_PORT" > .demo/verifier-app.url  # make e2e 가 읽는다

cat <<MSG

  ✅ 시연 준비 완료
     시민 지갑       http://localhost:$WALLET_PORT   (모바일 폭으로 보세요)
     검증기관 화면   http://localhost:$VERIFIER_APP_PORT
     발급기관 관리   http://localhost:8001/docs  (대구시)  ·  http://localhost:8003/docs (복지기관)
     로그            .demo/*.log
  docs/DEMO.md 의 ①~⑦ 순서대로 진행하세요 — ⑤ 폐기는 ⑦ 발급기관 정지보다 먼저 합니다.
  ⑦ 뒤에 발급기관을 다시 띄우려면 다른 터미널에서: make demo-issuers   (같은 포트·.demo/issuer-*.db 사용)
  종료: Ctrl+C

MSG
wait
