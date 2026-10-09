"""검증 성능 벤치: 실제 발급기관(대구시·복지기관)에서 VC 를 받아 검증기관에 N 회 제출, /present 왕복 p95 측정.
전제: 체인·발급기관(8001·8003)·검증기관(8002)이 떠 있음 (make demo).   결과 → docs/bench.json
실행: uv run python scripts/bench_verify.py [runs=50]
주소: ISSUER_DAEGU_URL · ISSUER_WELFARE_URL · VERIFIER_URL (make smoke 는 별도 포트 세트를 넘긴다)
기록 위치·체인 이름: BENCH_OUT (기본 docs/bench.json) · BENCH_CHAIN (기본 hardhat-localhost, Besu 로 잴 때 besu-qbft 등)

측정 범위 (보고할 때 함께 적는다):
- p50/p95/maxMs : 검증 서버 처리 = POST /present 왕복. 로컬 루프백, 같은 VC 2장을 반복 제출하므로 원장 조회 캐시가 대부분 적중한 상태.
- firstMs       : 이번 실행의 첫 제출 1회 (검증기관을 막 띄운 직후라면 캐시가 빈 콜드 상태).
- flowP95Ms     : POST /requests + VP 생성(서명) + POST /present 를 합친 p95.
QR 촬영·화면 렌더링·영수증 원장 앵커(응답 뒤 비동기)는 어느 값에도 들어 있지 않다.
"""
from __future__ import annotations

import json
import math
import os
import statistics
import sys
import time

import httpx
from dbp_vc import create_vp, generate_holder_key, sign_jws

ISSUER = os.environ.get("ISSUER_DAEGU_URL", "http://127.0.0.1:8001")
WELFARE = os.environ.get("ISSUER_WELFARE_URL", "http://127.0.0.1:8003")
VERIFIER = os.environ.get("VERIFIER_URL", "http://127.0.0.1:8002")
SCOPE = "검증 서버 처리(POST /present 왕복) — 로컬 루프백, 같은 VC 2장 반복 제출(규칙 번들 60초·발급기관 5초 캐시, 상태 목록은 매번 원장 조회). QR·화면·영수증 앵커 제외"


def percentile(sorted_values: list[float], p: float) -> float:
    """최근접 순위(nearest-rank) 백분위수: 정렬된 값의 ceil(p·n) 번째 (1부터 셈). n=50, p=0.95 → 48번째."""
    if not sorted_values:
        raise ValueError("빈 측정값")
    rank = max(1, math.ceil(p * len(sorted_values)))
    return sorted_values[rank - 1]


def summarize(totals: list[float], flows: list[float], server: list[float], verdicts: dict, runs: int) -> dict:
    first = totals[0]
    s, f = sorted(totals), sorted(flows)
    p95 = percentile(s, 0.95)
    return {"runs": runs, "verdicts": verdicts, "scope": SCOPE, "chain": os.environ.get("BENCH_CHAIN", "hardhat-localhost"),
            "meanMs": round(statistics.mean(s), 1), "p50Ms": round(percentile(s, 0.5), 1),
            "p95Ms": round(p95, 1), "maxMs": round(s[-1], 1), "firstMs": round(first, 1),
            "flowP95Ms": round(percentile(f, 0.95), 1),
            "serverMeanMs": round(statistics.mean(server), 1), "target": "p95 < 2000ms", "pass": p95 < 2000}


def issue(c: httpx.Client, base: str, holder, claims: list[str]) -> dict:
    ch = c.post(f"{base}/credentials/challenge", json={"holderDid": holder.did})
    ch.raise_for_status()
    ch = ch.json()
    proof = sign_jws(header={"alg": "EdDSA", "typ": "holder-proof+jwt"},
                     payload={"iss": holder.did, "aud": ch["aud"], "nonce": ch["nonce"]}, private_key=holder.private_key)
    r = c.post(f"{base}/credentials/issue", json={
        "citizenId": "C-001", "holderDid": holder.did, "holderProof": proof,
        "requestedClaims": claims, "consent": {"scope": claims, "ts": "2026-09-14T09:00:00Z"}})
    r.raise_for_status()
    return r.json()


def main() -> int:
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    holder = generate_holder_key()
    with httpx.Client(timeout=30) as c:
        issued = issue(c, ISSUER, holder, ["daeguResident"])
        issued2 = issue(c, WELFARE, holder, ["incomeBelow50Median"])
        vcs = [x["vcJwt"] for x in issued["credentials"] + issued2["credentials"]]
        assert len(vcs) == 2, (issued, issued2)
        totals, flows, server = [], [], []
        verdicts: dict[str, int] = {}
        for _ in range(runs):
            t_flow = time.perf_counter()
            r = c.post(f"{VERIFIER}/requests", json={})
            r.raise_for_status()
            r = r.json()
            vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=r["verifier"],
                           nonce=r["nonce"], vc_jwts=vcs)
            t0 = time.perf_counter()
            res = c.post(f"{VERIFIER}/present", json={"requestId": r["requestId"], "vpJwt": vp})
            res.raise_for_status()
            res = res.json()
            t1 = time.perf_counter()
            totals.append((t1 - t0) * 1000)
            flows.append((t1 - t_flow) * 1000)
            server.append(res["timingsMs"]["total"])
            verdicts[res["verdict"]] = verdicts.get(res["verdict"], 0) + 1
    out = summarize(totals, flows, server, verdicts, runs)
    path = os.environ.get("BENCH_OUT", "docs/bench.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
