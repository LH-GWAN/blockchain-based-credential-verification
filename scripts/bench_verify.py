"""검증 성능 벤치: 실제 발급기관(대구시)에서 VC 를 받아 검증기관에 N 회 제출, /present 총 소요 p95 측정.
전제: 체인·발급기관(8001)·검증기관(8002)이 떠 있음 (make demo).   결과 → docs/bench.json
실행: uv run python scripts/bench_verify.py [runs=50]
"""
from __future__ import annotations

import json
import statistics
import sys
import time

import httpx

from dbp_vc import create_vp, generate_holder_key, sign_jws

ISSUER = "http://localhost:8001"
VERIFIER = "http://localhost:8002"


def main() -> int:
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    holder = generate_holder_key()
    with httpx.Client(timeout=30) as c:
        ch = c.post(f"{ISSUER}/credentials/challenge", json={"holderDid": holder.did}).json()
        proof = sign_jws(header={"alg": "EdDSA", "typ": "holder-proof+jwt"},
                         payload={"iss": holder.did, "aud": ch["aud"], "nonce": ch["nonce"]}, private_key=holder.private_key)
        req = ["daeguResident", "incomeBelow50Median"]
        issued = c.post(f"{ISSUER}/credentials/issue", json={
            "citizenId": "C-001", "holderDid": holder.did, "holderProof": proof,
            "requestedClaims": req, "consent": {"scope": req, "ts": "2026-09-14T09:00:00Z"}}).json()
        vcs = [x["vcJwt"] for x in issued["credentials"]]
        assert len(vcs) == 2, issued
        totals, server = [], []
        verdicts = {}
        for _ in range(runs):
            r = c.post(f"{VERIFIER}/requests", json={}).json()
            vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=r["verifier"],
                           nonce=r["nonce"], vc_jwts=vcs)
            t0 = time.perf_counter()
            res = c.post(f"{VERIFIER}/present", json={"requestId": r["requestId"], "vpJwt": vp}).json()
            totals.append((time.perf_counter() - t0) * 1000)
            server.append(res["timingsMs"]["total"])
            verdicts[res["verdict"]] = verdicts.get(res["verdict"], 0) + 1
    totals.sort()
    out = {"runs": runs, "verdicts": verdicts,
           "meanMs": round(statistics.mean(totals), 1), "p50Ms": round(totals[len(totals) // 2], 1),
           "p95Ms": round(totals[int(len(totals) * 0.95) - 1], 1), "maxMs": round(totals[-1], 1),
           "serverMeanMs": round(statistics.mean(server), 1), "target": "p95 < 2000ms", "pass": totals[int(len(totals) * 0.95) - 1] < 2000}
    with open("docs/bench.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
