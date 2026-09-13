#!/usr/bin/env bash
# 통합 스모크: Hardhat 체인 → 배포 → 시드 → 발급기관 2 + 검증기관 기동 → 발급·제출 벤치(N회) → 폐기 차단 → PII 스캔
# 결과: docs/bench.json (벤치), 표준출력 요약. 종료 시 모든 자식 프로세스 정리.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNS="${1:-50}"
export RULE_EVAL_DATE="${RULE_EVAL_DATE:-2026-09-14}"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
./scripts/fix_venv.sh
mkdir -p .smoke
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
rpc_ok() { curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null 2>&1; }
wait_http() { local url=$1 n=0; until curl -sf "$url" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 60 ] && { echo "timeout waiting $url"; exit 1; }; sleep 1; done; }

if rpc_ok; then echo "[smoke] 기존 체인 사용 $RPC_URL"; else
  echo "[smoke] Hardhat 체인 기동"; (pnpm --filter @dbp/chain node > .smoke/chain.log 2>&1) & PIDS+=($!)
  n=0; until rpc_ok; do n=$((n+1)); [ $n -gt 60 ] && { echo "chain timeout"; cat .smoke/chain.log | tail -20; exit 1; }; sleep 1; done
fi
echo "[smoke] 배포"; pnpm --filter @dbp/chain deploy:localhost > .smoke/deploy.log 2>&1 || { tail -20 .smoke/deploy.log; exit 1; }
echo "[smoke] 시드"; uv run python scripts/seed_ledger.py | tail -4

echo "[smoke] 서비스 기동"
(ISSUER_ID=daegu ISSUER_PORT=8001 ISSUER_DB_PATH=.smoke/issuer-daegu.db uv run python -m dbp_issuer > .smoke/issuer-daegu.log 2>&1) & PIDS+=($!)
(ISSUER_ID=welfare ISSUER_PORT=8003 ISSUER_DB_PATH=.smoke/issuer-welfare.db uv run python -m dbp_issuer > .smoke/issuer-welfare.log 2>&1) & PIDS+=($!)
(VERIFIER_PORT=8002 uv run python -m dbp_verifier > .smoke/verifier.log 2>&1) & PIDS+=($!)
wait_http http://localhost:8001/health; wait_http http://localhost:8003/health; wait_http http://localhost:8002/health
curl -s http://localhost:8001/health; echo; curl -s http://localhost:8002/health; echo

echo "[smoke] 벤치 ${RUNS}회"; uv run python scripts/bench_verify.py "$RUNS" | grep -E '"(runs|verdicts|meanMs|p95Ms|maxMs|pass)"' 

echo "[smoke] 폐기 차단 + 은행 발급 + 재사용"; uv run python - <<'PY'
import httpx, json
from dbp_vc import create_vp, generate_holder_key, sign_jws
D, B, V = "http://localhost:8001", "http://localhost:8003", "http://localhost:8002"
h = generate_holder_key()
def issue(base, claims, cid="C-001"):
    ch = httpx.post(f"{base}/credentials/challenge", json={"holderDid": h.did}).json()
    proof = sign_jws(header={"alg":"EdDSA","typ":"holder-proof+jwt"}, payload={"iss":h.did,"aud":ch["aud"],"nonce":ch["nonce"]}, private_key=h.private_key)
    r = httpx.post(f"{base}/credentials/issue", json={"citizenId":cid,"holderDid":h.did,"holderProof":proof,"requestedClaims":claims,"consent":{"scope":claims,"ts":"2026-09-14T09:00:00Z"}}, timeout=60)
    r.raise_for_status(); return r.json()
d = issue(D, ["daeguResident","ageOver65","hasStudentChild"])
b = issue(B, ["incomeBelow50Median","incomeBelow32Median","annualIncomeUnder35M"])
print(" 대구시 발급:", [c["claim"] for c in d["credentials"]], "거부:", [x["claim"] for x in d["denied"]], "동의영수증 tx:", (d["consentReceipt"]["txHash"] or "")[:14])
print(" 복지기관 발급:", [c["claim"] for c in b["credentials"]], "거부:", [x["claim"] for x in b["denied"]], "tx:", (b["consentReceipt"]["txHash"] or "")[:14])
vcs = {c["claim"]: c for c in d["credentials"] + b["credentials"]}
def present(claims, requested):
    r = httpx.post(f"{V}/requests", json={"requested":[{"claim":c,"expected":True} for c in requested]}).json()
    vp = create_vp(holder_did=h.did, holder_private_key=h.private_key, verifier_did=r["verifier"], nonce=r["nonce"], vc_jwts=[vcs[c]["vcJwt"] for c in claims])
    return httpx.post(f"{V}/present", json={"requestId":r["requestId"],"vpJwt":vp}, timeout=60).json()
res = present(["daeguResident","annualIncomeUnder35M"], ["daeguResident","annualIncomeUnder35M"])
print(" 두 발급기관 혼합 제출(햇살론뱅크 용도):", res["verdict"], res["reasonCodes"], "발급기관:", res["issuers"], f"{res['timingsMs']['total']}ms")
assert res["verdict"] == "PASS"
rv = httpx.post(f"{D}/admin/credentials/{vcs['incomeBelow50Median']['jti']}/revoke", timeout=60).json()
print(" 폐기:", rv["revoked"], "상태목록 v", rv["statusListVersion"], "tx:", (rv["txHash"] or "")[:14])
res = present(["daeguResident","incomeBelow50Median"], ["daeguResident","incomeBelow50Median"])
print(" 폐기 후 제출:", res["verdict"], res["reasonCodes"], f"{res['timingsMs']['total']}ms")
assert res["verdict"] == "FAIL" and "REVOKED" in res["reasonCodes"]
for kind in ["replay","expired","forged","wrong-holder"]:
    a = httpx.post(f"{V}/demo/attack", json={"kind":kind}).json()
    print(f" 공격 {kind:12s}:", a["verdict"], a["reasonCodes"])
    assert a["verdict"] == "FAIL"
PY

echo "[smoke] PII 스캔"; SCAN=$(cd chain && pnpm scan-pii --names 김복례,이순자,박영희 2>&1 | grep -E "scanned|PASS|FAIL" | tr '\n' ' '); echo "$SCAN"
uv run python - "$SCAN" <<'PY'
import json, sys, re, pathlib
p = pathlib.Path("docs/bench.json"); d = json.loads(p.read_text()) if p.exists() else {}
m = re.search(r"blocks=(\d+) txs=(\d+) logs=(\d+) findings=(\d+)", sys.argv[1])
d["piiScan"] = (("PASS" if "PASS" in sys.argv[1] else "FAIL") + (f" (blocks={m[1]}, txs={m[2]}, logs={m[3]}, findings={m[4]})" if m else ""))
p.write_text(json.dumps(d, ensure_ascii=False, indent=2))
PY
echo "[smoke] 완료"
