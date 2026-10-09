#!/usr/bin/env bash
# 통합 스모크: Hardhat 체인 → 배포 → 시드 → 발급기관 2 + 검증기관 기동 → 발급·제출 벤치(N회) → 폐기 차단 → PII 스캔
# 결과: docs/bench.json (벤치), 표준출력 요약. 종료 시 모든 자식 프로세스 정리.
# 서비스 포트는 시연 스택(make demo: 8001~8004)과 겹치지 않게 별도 세트(기본 8101~8103)를 쓴다.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNS="${1:-50}"
export RULE_EVAL_DATE="${RULE_EVAL_DATE:-2026-09-14}"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
SMOKE_DAEGU_PORT="${SMOKE_DAEGU_PORT:-8101}"
SMOKE_VERIFIER_PORT="${SMOKE_VERIFIER_PORT:-8102}"
SMOKE_WELFARE_PORT="${SMOKE_WELFARE_PORT:-8103}"
# bench_verify.py 와 아래 인라인 검사가 읽는다
export ISSUER_DAEGU_URL="http://127.0.0.1:$SMOKE_DAEGU_PORT"
export ISSUER_WELFARE_URL="http://127.0.0.1:$SMOKE_WELFARE_PORT"
export VERIFIER_URL="http://127.0.0.1:$SMOKE_VERIFIER_PORT"
./scripts/fix_venv.sh
mkdir -p .smoke
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
rpc_ok() { curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null 2>&1; }
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
# 새로 띄운 프로세스($2)가 살아 있는 채로 응답해야 한다 — 남아 있던 다른 프로세스의 응답으로 통과하지 않게
wait_http() {
  local url=$1 pid=${2:-} n=0
  until curl -sf "$url" >/dev/null 2>&1; do
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "[smoke] $url 프로세스가 종료됨 — .smoke/*.log 확인"; exit 1; fi
    n=$((n+1)); [ $n -gt 60 ] && { echo "timeout waiting $url"; exit 1; }; sleep 1
  done
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "[smoke] $url 프로세스가 종료됨 — .smoke/*.log 확인"; exit 1; fi
}

for port in "$SMOKE_DAEGU_PORT" "$SMOKE_VERIFIER_PORT" "$SMOKE_WELFARE_PORT"; do
  port_free "$port" || { echo "[smoke] 포트 $port 가 이미 사용 중입니다 — 남은 프로세스를 정리하세요:"; lsof -nP -iTCP:"$port" -sTCP:LISTEN || true; exit 1; }
done
if rpc_ok; then
  # 같은 체인에 다시 배포하면 chain/deployments/latest.json 이 바뀌어, 떠 있는 시연 스택의 원장 주소가 어긋난다
  if ! port_free 8001 || ! port_free 8003; then
    echo "[smoke] make demo 스택(8001/8003)이 같은 체인($RPC_URL)을 쓰고 있습니다 — 재배포하면 시연 스택이 깨지므로 중단합니다. 시연 스택을 끈 뒤 다시 실행하세요."
    exit 1
  fi
  echo "[smoke] 기존 체인 사용 $RPC_URL"
else
  echo "[smoke] Hardhat 체인 기동"; (pnpm --filter @dbp/chain node > .smoke/chain.log 2>&1) & PIDS+=($!)
  n=0; until rpc_ok; do n=$((n+1)); [ $n -gt 60 ] && { echo "chain timeout"; cat .smoke/chain.log | tail -20; exit 1; }; sleep 1; done
fi
echo "[smoke] 배포"; pnpm --filter @dbp/chain deploy:localhost > .smoke/deploy.log 2>&1 || { tail -20 .smoke/deploy.log; exit 1; }
echo "[smoke] 시드"; uv run python scripts/seed_ledger.py | tail -4

echo "[smoke] 서비스 기동 (대구시 $SMOKE_DAEGU_PORT · 검증기관 $SMOKE_VERIFIER_PORT · 복지기관 $SMOKE_WELFARE_PORT)"
(ISSUER_ID=daegu ISSUER_PORT=$SMOKE_DAEGU_PORT ISSUER_DB_PATH=.smoke/issuer-daegu.db uv run python -m dbp_issuer > .smoke/issuer-daegu.log 2>&1) & PIDS+=($!); P_DAEGU=$!
(ISSUER_ID=welfare ISSUER_PORT=$SMOKE_WELFARE_PORT ISSUER_DB_PATH=.smoke/issuer-welfare.db uv run python -m dbp_issuer > .smoke/issuer-welfare.log 2>&1) & PIDS+=($!); P_WELFARE=$!
(VERIFIER_PORT=$SMOKE_VERIFIER_PORT VERIFIER_PUBLIC_URL=$VERIFIER_URL uv run python -m dbp_verifier > .smoke/verifier.log 2>&1) & PIDS+=($!); P_VERIFIER=$!
wait_http "$ISSUER_DAEGU_URL/health" "$P_DAEGU"; wait_http "$ISSUER_WELFARE_URL/health" "$P_WELFARE"; wait_http "$VERIFIER_URL/health" "$P_VERIFIER"
curl -s "$ISSUER_DAEGU_URL/health"; echo; curl -s "$VERIFIER_URL/health"; echo

echo "[smoke] 벤치 ${RUNS}회"; uv run python scripts/bench_verify.py "$RUNS" | grep -E '"(runs|verdicts|meanMs|p95Ms|flowP95Ms|firstMs|maxMs|pass)"'

echo "[smoke] 폐기 차단 + 은행 발급 + 재사용"; uv run python - <<'PY'
import hashlib, os
import httpx
from dbp_vc import create_vp, generate_holder_key, sign_jws
D, B, V = os.environ["ISSUER_DAEGU_URL"], os.environ["ISSUER_WELFARE_URL"], os.environ["VERIFIER_URL"]
ADMIN = {"X-Admin-Token": os.environ["ADMIN_TOKEN"]} if os.environ.get("ADMIN_TOKEN") else {}
h = generate_holder_key()
def issue(base, claims, cid="C-001"):
    ch = httpx.post(f"{base}/credentials/challenge", json={"holderDid": h.did})
    ch.raise_for_status(); ch = ch.json()
    proof = sign_jws(header={"alg":"EdDSA","typ":"holder-proof+jwt"}, payload={"iss":h.did,"aud":ch["aud"],"nonce":ch["nonce"]}, private_key=h.private_key)
    r = httpx.post(f"{base}/credentials/issue", json={"citizenId":cid,"holderDid":h.did,"holderProof":proof,"requestedClaims":claims,"consent":{"scope":claims,"ts":"2026-09-14T09:00:00Z"}}, timeout=60)
    r.raise_for_status(); return r.json()
d = issue(D, ["daeguResident","ageOver65","hasStudentChild"])
b = issue(B, ["incomeBelow50Median","incomeBelow32Median","annualIncomeUnder35M"])
# 동의영수증 앵커는 응답 뒤에 처리되므로 txHash 가 아직 없을 수 있다
print(" 대구시 발급:", [c["claim"] for c in d["credentials"]], "거부:", [x["claim"] for x in d["denied"]], "동의영수증 tx:", ((d.get("consentReceipt") or {}).get("txHash") or "")[:14])
print(" 복지기관 발급:", [c["claim"] for c in b["credentials"]], "거부:", [x["claim"] for x in b["denied"]], "tx:", ((b.get("consentReceipt") or {}).get("txHash") or "")[:14])
vcs = {c["claim"]: c for c in d["credentials"] + b["credentials"]}
def confirm_code(vp: str) -> str:
    """지갑이 제출 직후 보여 주는 확인 숫자 4자리 (검증기관 결과의 confirmCode 와 같아야 한다)."""
    return str(int(hashlib.sha256(vp.encode("utf-8")).hexdigest()[:8], 16) % 10000).zfill(4)
def present(claims, requested, **kw):
    r = httpx.post(f"{V}/requests", json={"requested":[{"claim":c,"expected":True} for c in requested], **kw})
    r.raise_for_status(); r = r.json()
    vp = create_vp(holder_did=h.did, holder_private_key=h.private_key, verifier_did=r["verifier"], nonce=r["nonce"], vc_jwts=[vcs[c]["vcJwt"] for c in claims])
    # 결과는 /present 응답으로 받는다 (GET /results 는 창구 토큰 또는 vpHash 가 있어야 열린다)
    res = httpx.post(f"{V}/present", json={"requestId":r["requestId"],"vpJwt":vp}, timeout=60)
    res.raise_for_status(); res = res.json()
    assert res["confirmCode"] == confirm_code(vp), (res.get("confirmCode"), confirm_code(vp))
    return res, r
res, req = present(["daeguResident","annualIncomeUnder35M"], ["daeguResident","annualIncomeUnder35M"])
print(" 두 발급기관 혼합 제출(햇살론 일반보증 용도):", res["verdict"], res["reasonCodes"], "발급기관:", res["issuers"], f"{res['timingsMs']['total']}ms", "확인 숫자:", res["confirmCode"])
assert res["verdict"] == "PASS" and all(res["checks"].values()), res["checks"]
# GET /results: 토큰 없으면 401, 창구 토큰이면 같은 결과
assert httpx.get(f"{V}/results/{req['requestId']}").status_code == 401
got = httpx.get(f"{V}/results/{req['requestId']}", headers={"X-Counter-Token": req["counterToken"]})
got.raise_for_status(); assert got.json()["verdict"] == "PASS"
# ③ iM뱅크 → ③′ iM저축은행: 같은 '연소득 3,500만 원 이하' VC 를 재발급 없이 다시 제출 (2026 개편으로 저축은행도 햇살론 일반보증 취급)
for vid in ["imbank-branch-01", "im-savings-01"]:
    res, _ = present(["annualIncomeUnder35M"], ["annualIncomeUnder35M"], verifierId=vid, presetId="sunshine-general", policyId="sunshine-loan-general", purpose="햇살론 일반보증 대상 확인")
    print(f" 햇살론 일반보증 확인 @ {res['verifier']['name']}:", res["verdict"], res["reasonCodes"], "정책 판정:", res["policyCheck"]["eligible"], f"{res['timingsMs']['total']}ms")
    assert res["verdict"] == "PASS"
    # 제출된 VC 하나(연소득 3,500만 원 이하)만으로 정책 규칙이 참으로 확정된다 — 보류 항목·창구 확인 항목 없음
    assert res["policyCheck"] == {"policyId": "sunshine-loan-general", "eligible": True, "pending": [], "counterChecked": []}
# 새희망홀씨는 은행권 상품 → 저축은행 창구에서는 요청 단계에서 거부
r = httpx.post(f"{V}/requests", json={"verifierId":"im-savings-01","presetId":"new-hope","requested":[{"claim":"annualIncomeUnder40M","expected":True}]})
print(" 새희망홀씨 요청 @ 저축은행:", r.status_code, r.json().get("detail"))
assert r.status_code == 400 and r.json()["detail"] == "PRESET_NOT_OFFERED"
# incomeBelow50Median 은 복지기관(B)이 발급했으므로 폐기도 복지기관에 요청한다
rv = httpx.post(f"{B}/admin/credentials/{vcs['incomeBelow50Median']['jti']}/revoke", headers=ADMIN, timeout=60)
rv.raise_for_status(); rv = rv.json()
print(" 폐기:", rv["revoked"], "상태목록 v", rv["statusListVersion"], "tx:", (rv["txHash"] or "")[:14])
assert rv["revoked"] is True and rv["txHash"]
res, _ = present(["daeguResident","incomeBelow50Median"], ["daeguResident","incomeBelow50Median"])
print(" 폐기 후 제출:", res["verdict"], res["reasonCodes"], f"{res['timingsMs']['total']}ms")
assert res["verdict"] == "FAIL" and "REVOKED" in res["reasonCodes"] and "policyCheck" not in res
for kind, code in [("replay", "NONCE_REUSED"), ("expired", "NONCE_EXPIRED"), ("forged", "VC_SIG_INVALID"), ("wrong-holder", "HOLDER_MISMATCH"), ("replay", "NONCE_REUSED")]:
    a = httpx.post(f"{V}/demo/attack", json={"kind":kind})
    a.raise_for_status(); a = a.json()
    print(f" 공격 {kind:12s}:", a["verdict"], a["reasonCodes"])
    assert a["verdict"] == "FAIL" and code in a["reasonCodes"], (kind, a["reasonCodes"])
PY

# 탐지 목록(이름 30명·citizenId·생년월일·소득)은 scan-pii 가 data/citizens.json 에서 직접 만든다 (F47)
echo "[smoke] PII 스캔"; SCAN=$(cd chain && pnpm scan-pii 2>&1 | grep -E "scanned|PASS|FAIL" | tr '\n' ' '); echo "$SCAN"
uv run python - "$SCAN" <<'PY'
import json, sys, re, pathlib
p = pathlib.Path("docs/bench.json"); d = json.loads(p.read_text()) if p.exists() else {}
m = re.search(r"blocks=(\d+) txs=(\d+) logs=(\d+) findings=(\d+)", sys.argv[1])
d["piiScan"] = (("PASS" if "PASS" in sys.argv[1] else "FAIL") + (f" (blocks={m[1]}, txs={m[2]}, logs={m[3]}, findings={m[4]})" if m else ""))
p.write_text(json.dumps(d, ensure_ascii=False, indent=2))
PY
echo "[smoke] 완료"
