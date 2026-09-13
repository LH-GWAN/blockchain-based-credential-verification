import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"

ISSUER_SEED = bytes([0x01]) * 32
HOLDER_SEED = bytes([0x02]) * 32
OTHER_SEED = bytes([0x03]) * 32

# 픽스처 VC 유효기간(2026-09-14 ~ 2027-09-14) 안의 고정 시각
NOW = datetime(2026, 9, 15, tzinfo=UTC)

ISSUER_DID = "did:dbp:daegu"
ISSUER_KID = "did:dbp:daegu#key-1"
VERIFIER_DID = "did:dbp:verifier-imbank-branch-01"
LIST_ID = "dbp:status:daegu:list-1"
EVIDENCE = {"bundle": "daegu-eligibility", "version": "2026.1", "bundleHash": "0x" + "ab" * 32}


def has_fixtures(lang: str) -> bool:
    return (FIXTURES_DIR / lang / "vc.json").exists()


def load_fixture(lang: str, name: str) -> dict:
    return json.loads((FIXTURES_DIR / lang / name).read_text(encoding="utf-8"))


@pytest.fixture
def vc_params():
    from dbp_vc import generate_holder_key

    issuer = generate_holder_key(ISSUER_SEED)
    holder = generate_holder_key(HOLDER_SEED)
    return {
        "id": "urn:uuid:11111111-1111-4111-8111-111111111111",
        "issuer_did": ISSUER_DID,
        "issuer_kid": ISSUER_KID,
        "issuer_private_key": issuer.private_key,
        "holder_did": holder.did,
        "claim": {"name": "incomeBelow50Median", "value": True},
        "valid_from": "2026-09-14T00:00:00Z",
        "valid_until": "2027-09-14T00:00:00Z",
        "status": {"listId": LIST_ID, "index": 1042},
        "evidence": EVIDENCE,
    }
