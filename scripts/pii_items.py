"""조회형(pull) 대비 보유형(hold) 전달 항목 비교 → data/comparison.json

- 조회형: 검증기관 프리셋의 요청 항목을 확인하려면 공공 마이데이터로 어떤 행정서류(원문)가 넘어오는지,
  그 서류들에 담긴 항목의 합집합을 센다 (data/legacy-documents.json — 공식 서식 기준, 실제 API 호출 결과가 아님).
- 보유형: 같은 프리셋에서 혜택패스가 실제로 전달하는 참·거짓 항목. 예시 VP 를 만들어 VC 안의 사실 개수를 실측한다.
- 결과: 프리셋별 {pullDocuments, pullItems, pullCount, holdItems, holdCount, reductionPercent, pullRecords, holdRecords}.
숫자·항목을 화면에 하드코딩하지 않고 검증 서비스가 이 파일을 읽어 결과에 넣는다.
실행: uv run python scripts/pii_items.py   (종료 코드 1 = 어느 프리셋이든 70% 미달)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from dbp_rules import load_bundle, repo_root

ROOT = repo_root()
LEGACY = json.loads((ROOT / "data/legacy-documents.json").read_text(encoding="utf-8"))
from dbp_verifier.comparison import HONESTY  # noqa: E402


from dbp_verifier.comparison import build_comparison  # noqa: E402  (단일 출처)


def measured_hold_count(requested: list[dict], issuer_of: dict[str, str]) -> int:
    """예시 VP 를 실제로 만들어 VC 안의 사실 개수를 센다 (문서 주장이 아니라 실측)."""
    from dbp_vc import create_vp, decode_vc, generate_holder_key, issue_vc
    from dbp_verifier.verify import decode_jwt_unverified
    holder = generate_holder_key(bytes([2]) * 32)
    vcs = []
    for i, r in enumerate(requested):
        issuer_did = issuer_of.get(r["claim"], "did:dbp:daegu")
        issuer = generate_holder_key(bytes([1 if issuer_did.endswith("daegu") else 3]) * 32)
        vcs.append(issue_vc(id=f"urn:uuid:demo-{r['claim']}", issuer_did=issuer_did, issuer_kid=issuer_did + "#key-1",
                            issuer_private_key=issuer.private_key, holder_did=holder.did,
                            claim={"name": r["claim"], "value": bool(r.get("expected", True))},
                            valid_from="2026-09-01T00:00:00Z", valid_until="2027-09-14T00:00:00Z",
                            status={"listId": f"dbp:status:{issuer_did.split(':')[-1]}:list-1", "index": i},
                            evidence={"bundle": "daegu-eligibility", "version": "2026.1", "bundleHash": "0x" + "00" * 32}))
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key,
                   verifier_did="did:dbp:verifier-imbank-branch-01", nonce="n_demo", vc_jwts=vcs)
    _, payload = decode_jwt_unverified(vp)
    n = 0
    for vc_jwt in payload["vp"]["verifiableCredential"]:
        vc = decode_vc(vc_jwt)["vc"]
        n += len([k for k in vc["credentialSubject"] if k != "id"])
    return n


def main() -> int:
    from dbp_verifier.config import PRESETS
    bundle = load_bundle()
    labels, issuer_of = bundle["claims"]["labels"], bundle["claims"]["issuerOf"]
    presets = {}
    for p in PRESETS:
        c = build_comparison(p["requested"], labels, p["id"])
        c["label"] = p["label"]
        c["measuredHoldCount"] = measured_hold_count(p["requested"], issuer_of)
        assert c["measuredHoldCount"] == c["holdCount"], (p["id"], c)
        presets[p["id"]] = c
    out = {
        "source": "scripts/pii_items.py (data/legacy-documents.json 기반 계산 + 예시 VP 실측)",
        "honestyNote": HONESTY,
        "target": ">=70%",
        "documents": LEGACY["documents"], "claimDocuments": LEGACY["claimDocuments"], "records": LEGACY["records"],
        "presets": presets,
        "pass": all(c["reductionPercent"] >= 70 for c in presets.values()),
    }
    (ROOT / "data/comparison.json").write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: {"pull": v["pullCount"], "hold": v["holdCount"], "reduction": v["reductionPercent"],
                          "docs": [d["name"] for d in v["pullDocuments"]]} for k, v in presets.items()} | {"pass": out["pass"]},
                     ensure_ascii=False, indent=2))
    print("wrote data/comparison.json")
    return 0 if out["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
