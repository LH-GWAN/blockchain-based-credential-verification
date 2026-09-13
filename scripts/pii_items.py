"""개인정보 최소화 지표: 기존 서류 신청 시 기관에 전달되는 항목 수 vs 혜택패스 제출(VP)에 실제 포함된 항목 수.

기존(서민금융 상담·복지 신청 창구 기준, 약 10개 항목): 이름, 주민등록번호, 주소, 연락처, 가구원수,
월 소득금액, 소득증명서 원본, 장애·수급 정보, 계좌번호, 신분증 사본.
혜택패스: 기관에 전달되는 '개인정보 항목'은 VP 안의 claim(참/거짓)뿐이다. 발급기관 식별자와 유효상태(폐기 여부)는
시민에 관한 정보가 아니라 증명서 메타데이터이므로 별도로 표기한다.
실행: uv run python scripts/pii_items.py   (VP 를 인자로 주지 않으면 시연 페르소나 기준 예시 VP 를 만든다)
"""
from __future__ import annotations

import json
import sys

LEGACY_ITEMS = ["이름", "주민등록번호", "주소", "연락처", "가구원수", "월 소득금액", "소득증명서 원본",
                "장애·수급 정보", "계좌번호", "신분증 사본"]


def items_in_vp(vp_jwt: str) -> tuple[list[str], list[str]]:
    """(개인정보 항목, 증명서 메타데이터) 를 돌려준다."""
    from dbp_vc import decode_vc
    from dbp_verifier.verify import decode_jwt_unverified
    _, payload = decode_jwt_unverified(vp_jwt)
    personal: list[str] = []
    issuers: set[str] = set()
    for vc_jwt in payload["vp"]["verifiableCredential"]:
        vc = decode_vc(vc_jwt)["vc"]
        subj = {k: v for k, v in vc["credentialSubject"].items() if k != "id"}
        for k, v in subj.items():
            personal.append(f"{k}={v}")
        issuers.add(vc["issuer"])
    meta = [f"발급기관:{i}" for i in sorted(issuers)] + ["유효상태(폐기 여부)", "제출자 DID(가명 키)"]
    return personal, meta


SCENARIOS = {
    "서민금융 상담 대상 확인": [("did:dbp:daegu", "daeguResident"), ("did:dbp:welfare", "incomeBelow50Median")],
    "햇살론뱅크 대상 확인": [("did:dbp:welfare", "annualIncomeUnder35M")],
}


def example_vp(claims: list[tuple[str, str]]) -> str:
    from dbp_vc import create_vp, generate_holder_key, issue_vc
    holder = generate_holder_key(bytes([2]) * 32)
    vcs = []
    for i, (issuer_did, c) in enumerate(claims):
        issuer = generate_holder_key(bytes([1 if issuer_did.endswith("daegu") else 3]) * 32)
        vcs.append(issue_vc(id=f"urn:uuid:demo-{c}", issuer_did=issuer_did, issuer_kid=issuer_did + "#key-1",
                            issuer_private_key=issuer.private_key, holder_did=holder.did, claim={"name": c, "value": True},
                            valid_from="2026-09-01T00:00:00Z", valid_until="2027-09-14T00:00:00Z",
                            status={"listId": f"dbp:status:{issuer_did.split(':')[-1]}:list-1", "index": i},
                            evidence={"bundle": "daegu-eligibility", "version": "2026.1", "bundleHash": "0x" + "00" * 32}))
    return create_vp(holder_did=holder.did, holder_private_key=holder.private_key,
                     verifier_did="did:dbp:verifier-imbank-branch-01", nonce="n_demo", vc_jwts=vcs)


def measure(vp: str) -> dict:
    personal, meta = items_in_vp(vp)
    reduction = round((1 - len(personal) / len(LEGACY_ITEMS)) * 100)
    return {"benefitPassPersonalItems": personal, "benefitPassCount": len(personal),
            "credentialMetadata(not personal data)": meta, "reductionPercent": reduction, "pass": reduction >= 70}


def main() -> int:
    if len(sys.argv) > 1:
        scenarios = {"(제공된 VP)": measure(sys.argv[1])}
    else:
        scenarios = {name: measure(example_vp(claims)) for name, claims in SCENARIOS.items()}
    first = next(iter(scenarios.values()))
    report = {"legacyPersonalItems": LEGACY_ITEMS, "legacyCount": len(LEGACY_ITEMS), "target": ">=70%",
              "scenarios": scenarios,
              # 하위 호환 (리포트 생성기): 대표 시나리오 = 서민금융 상담(2항목)
              "benefitPassPersonalItems": first["benefitPassPersonalItems"], "benefitPassCount": first["benefitPassCount"],
              "reductionPercent": first["reductionPercent"], "pass": all(s["pass"] for s in scenarios.values())}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
