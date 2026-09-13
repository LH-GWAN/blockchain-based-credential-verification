"""개인정보 최소화 지표: 기존 서류 신청 시 기관에 전달되는 항목 수 vs 혜택패스 제출(VP)에 실제 포함된 항목 수.

기존(서민금융 상담·복지 신청 창구 기준, 약 10개 항목): 이름, 주민등록번호, 주소, 연락처, 가구원수,
월 소득금액, 소득증명서 원본, 장애·수급 정보, 계좌번호, 신분증 사본.
혜택패스: VP 안의 claim(참/거짓) + 발급기관 식별자 + 유효상태(폐기 여부) 만 기관에 전달된다.
실행: uv run python scripts/pii_items.py   (VP 를 인자로 주지 않으면 시연 페르소나 기준 예시 VP 를 만든다)
"""
from __future__ import annotations

import json
import sys

LEGACY_ITEMS = ["이름", "주민등록번호", "주소", "연락처", "가구원수", "월 소득금액", "소득증명서 원본",
                "장애·수급 정보", "계좌번호", "신분증 사본"]


def items_in_vp(vp_jwt: str) -> list[str]:
    from dbp_vc import decode_vc
    from dbp_verifier.verify import decode_jwt_unverified
    _, payload = decode_jwt_unverified(vp_jwt)
    items: list[str] = []
    issuers: set[str] = set()
    for vc_jwt in payload["vp"]["verifiableCredential"]:
        vc = decode_vc(vc_jwt)
        subj = {k: v for k, v in vc["credentialSubject"].items() if k != "id"}
        for k, v in subj.items():
            items.append(f"{k}={v}")
        issuers.add(vc["issuer"])
    items += [f"발급기관:{i}" for i in sorted(issuers)]
    items.append("유효상태(폐기 여부)")
    return items


def example_vp() -> str:
    from dbp_vc import create_vp, generate_holder_key, issue_vc
    issuer = generate_holder_key(bytes([1]) * 32)
    holder = generate_holder_key(bytes([2]) * 32)
    vcs = [issue_vc(id=f"urn:uuid:demo-{c}", issuer_did="did:dbp:daegu", issuer_kid="did:dbp:daegu#key-1",
                    issuer_private_key=issuer.private_key, holder_did=holder.did, claim={"name": c, "value": True},
                    valid_from="2026-09-14T00:00:00Z", valid_until="2027-09-14T00:00:00Z",
                    status={"listId": "dbp:status:daegu:list-1", "index": i},
                    evidence={"bundle": "daegu-eligibility", "version": "2026.1", "bundleHash": "0x" + "00" * 32})
           for i, c in enumerate(["daeguResident", "incomeBelow50Median"])]
    return create_vp(holder_did=holder.did, holder_private_key=holder.private_key,
                     verifier_did="did:dbp:verifier-imbank-branch-01", nonce="n_demo", vc_jwts=vcs)


def main() -> int:
    vp = sys.argv[1] if len(sys.argv) > 1 else example_vp()
    ours = items_in_vp(vp)
    reduction = round((1 - len(ours) / len(LEGACY_ITEMS)) * 100)
    report = {"legacyItems": LEGACY_ITEMS, "legacyCount": len(LEGACY_ITEMS), "benefitPassItems": ours,
              "benefitPassCount": len(ours), "reductionPercent": reduction, "target": ">=70%", "pass": reduction >= 70}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
