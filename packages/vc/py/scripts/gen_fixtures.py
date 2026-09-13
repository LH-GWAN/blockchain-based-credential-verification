"""결정론적 크로스언어 픽스처 생성 → packages/vc/fixtures/py/*.json
issuer seed = 0x01×32, holder seed = 0x02×32, 고정 타임스탬프. TS 쪽 scripts/gen-fixtures.ts 와 1:1.

실행: uv run python packages/vc/py/scripts/gen_fixtures.py
"""

import json
from pathlib import Path

from dbp_vc import (
    bundle_hash,
    canonicalize,
    create_status_list,
    create_vp,
    decode_vc,
    ed25519_public_key_hex,
    encode_status_list,
    generate_holder_key,
    iso_to_seconds,
    issue_vc,
    set_status,
    sha256_hex,
)

OUT = Path(__file__).resolve().parents[2] / "fixtures" / "py"

issuer = generate_holder_key(bytes([0x01]) * 32)  # did:dbp 발급기관의 Ed25519 키로 사용
holder = generate_holder_key(bytes([0x02]) * 32)

ISSUER_DID = "did:dbp:daegu"
ISSUER_KID = "did:dbp:daegu#key-1"
VERIFIER_DID = "did:dbp:verifier-imbank-branch-01"
VALID_FROM = "2026-09-14T00:00:00Z"
VALID_UNTIL = "2027-09-14T00:00:00Z"
VP_IAT = iso_to_seconds("2026-09-14T09:00:00Z")
NONCE = "n_fixture00000000000000000000001"
LIST_ID = "dbp:status:daegu:list-1"

# jcs.json — 한글, 이스케이프, 제어문자, 중첩, 키 정렬을 모두 포함 (TS와 동일 객체; -0 은 0)
jcs_obj = {
    "z": [1, True, None, "x"],
    "a": {"nested": 'quote"and\\slash\nnewline\ttab', "ctrl": "\u0001\u001f\u007f", "가": "대구광역시"},
    "B": 0,
    "0": 9007199254740991,
    "_": {"": [], "empty": {}},
    "bundle": "daegu-eligibility",
    "version": "2026.1",
    "rule": {
        "incomeBelow50Median": {
            "<=": [{"*": [{"var": "monthlyIncomeKRW"}, 100]}, {"*": [{"var": "medianIncomeKRW"}, 50]}],
        },
    },
}
canonical = canonicalize(jcs_obj)
BUNDLE_HASH = bundle_hash(jcs_obj)

common = {
    "issuer_did": ISSUER_DID,
    "issuer_kid": ISSUER_KID,
    "issuer_private_key": issuer.private_key,
    "holder_did": holder.did,
    "valid_from": VALID_FROM,
    "valid_until": VALID_UNTIL,
    "evidence": {"bundle": "daegu-eligibility", "version": "2026.1", "bundleHash": BUNDLE_HASH},
}
vc1 = issue_vc(
    id="urn:uuid:00000000-0000-4000-8000-000000000001",
    claim={"name": "incomeBelow50Median", "value": True},
    status={"listId": LIST_ID, "index": 1042},
    **common,
)
vc2 = issue_vc(
    id="urn:uuid:00000000-0000-4000-8000-000000000002",
    claim={"name": "daeguResident", "value": True},
    status={"listId": LIST_ID, "index": 7},
    **common,
)

vp = create_vp(
    holder_did=holder.did,
    holder_private_key=holder.private_key,
    verifier_did=VERIFIER_DID,
    nonce=NONCE,
    vc_jwts=[vc1, vc2],
    iat=VP_IAT,
)

revoked_indices = [0, 7, 8, 1042, 65535, 131071]
status_list = create_status_list()
for i in revoked_indices:
    set_status(status_list, i, True)

files = {
    "didkey.json": {"publicKeyHex": holder.public_key.hex(), "did": holder.did},
    "jcs.json": {"obj": jcs_obj, "canonical": canonical, "hash": BUNDLE_HASH, "sha256": sha256_hex(canonical)},
    "vc.json": {
        "jwt": vc1,
        "issuerDid": ISSUER_DID,
        "issuerPublicKeyHex": ed25519_public_key_hex(issuer.private_key),
        "holderDid": holder.did,
        "payload": decode_vc(vc1)["payload"],
    },
    "vp.json": {
        "jwt": vp,
        "verifierDid": VERIFIER_DID,
        "nonce": NONCE,
        "vcJwts": [vc1, vc2],
        "holderDid": holder.did,
        "iat": VP_IAT,
    },
    "statuslist.json": {
        "size": len(status_list) * 8,
        "revokedIndices": revoked_indices,
        "encoded": encode_status_list(status_list),
    },
}

OUT.mkdir(parents=True, exist_ok=True)
for name, data in files.items():
    (OUT / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", OUT / name)
