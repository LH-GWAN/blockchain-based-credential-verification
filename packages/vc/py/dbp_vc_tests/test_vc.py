import json
import re
from datetime import UTC, datetime

import pytest
from dbp_vc import VcError, b64url_decode, b64url_encode, decode_vc, generate_holder_key, issue_vc, verify_vc

from .conftest import EVIDENCE, HOLDER_SEED, ISSUER_DID, ISSUER_KID, ISSUER_SEED, LIST_ID, NOW, OTHER_SEED

issuer = generate_holder_key(ISSUER_SEED)
holder = generate_holder_key(HOLDER_SEED)
other = generate_holder_key(OTHER_SEED)


def test_payload_shape(vc_params):
    jwt = issue_vc(**vc_params)
    d = decode_vc(jwt)
    assert d["header"] == {"alg": "EdDSA", "typ": "vc+jwt", "kid": ISSUER_KID}
    assert d["payload"] == {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        "id": vc_params["id"],
        "type": ["VerifiableCredential", "DaeguEligibilityCredential"],
        "issuer": ISSUER_DID,
        "validFrom": "2026-09-14T00:00:00Z",
        "validUntil": "2027-09-14T00:00:00Z",
        "credentialSubject": {"id": holder.did, "incomeBelow50Median": True},
        "credentialSchema": {"id": "dbp:schema:atomic-claim:1", "type": "JsonSchema"},
        "credentialStatus": {
            "type": "BitstringStatusListEntry",
            "statusPurpose": "revocation",
            "statusListIndex": "1042",
            "statusListCredential": LIST_ID,
        },
        "evidence": [{"type": "RuleEvaluation", **EVIDENCE}],
        "iss": ISSUER_DID,
        "sub": holder.did,
        "nbf": 1789344000,
        "exp": 1820880000,
        "jti": vc_params["id"],
    }
    assert list(d["payload"])[-5:] == ["iss", "sub", "nbf", "exp", "jti"]
    assert "iss" not in d["vc"] and "exp" not in d["vc"]


def test_atomic_subject(vc_params):
    vc = decode_vc(issue_vc(**vc_params))["vc"]
    assert sorted(vc["credentialSubject"]) == ["id", "incomeBelow50Median"]
    assert not re.search(r"\d{6}-\d{7}", json.dumps(vc))


def test_deterministic(vc_params):
    assert issue_vc(**vc_params) == issue_vc(**vc_params)


@pytest.mark.parametrize(
    "patch",
    [
        {"claim": {"name": "x", "value": "true"}},
        {"claim": {"name": "id", "value": True}},
        {"status": {"listId": LIST_ID, "index": 1.5}},
        {"status": {"listId": LIST_ID, "index": -1}},
        {"status": {"listId": LIST_ID, "index": True}},
        {"valid_from": "2026-09-14T00:00:00"},
        {"valid_from": "2026-09-14"},
        {"valid_until": "2026-09-14T00:00:00Z"},
    ],
)
def test_rejects_invalid_inputs(vc_params, patch):
    with pytest.raises(VcError):
        issue_vc(**{**vc_params, **patch})


def test_verify_ok(vc_params):
    jwt = issue_vc(**vc_params)
    res = verify_vc(jwt, issuer.public_key, now=NOW)
    assert res["checks"] == {"signature": True, "notExpired": True, "active": True}
    assert res["vc"]["credentialSubject"]["id"] == holder.did
    assert res["payload"]["jti"] == vc_params["id"]


def test_verify_time_checks(vc_params):
    jwt = issue_vc(**vc_params)
    expired = verify_vc(jwt, issuer.public_key, now=datetime(2027, 9, 14, tzinfo=UTC))["checks"]
    assert expired == {"signature": True, "notExpired": False, "active": True}
    early = verify_vc(jwt, issuer.public_key, now=datetime(2026, 9, 13, 23, 59, 59, tzinfo=UTC))["checks"]
    assert early == {"signature": True, "notExpired": True, "active": False}
    assert verify_vc(jwt, issuer.public_key, now=1789344000)["checks"]["active"] is True
    # naive datetime은 UTC로 간주
    assert verify_vc(jwt, issuer.public_key, now=datetime(2026, 9, 15))["checks"]["active"] is True  # noqa: DTZ001


def test_verify_wrong_key_and_tamper(vc_params):
    jwt = issue_vc(**vc_params)
    assert verify_vc(jwt, other.public_key, now=NOW)["checks"]["signature"] is False
    h, p, s = jwt.split(".")
    payload = json.loads(b64url_decode(p))
    payload["credentialSubject"]["incomeBelow50Median"] = False
    forged = f"{h}.{b64url_encode(json.dumps(payload).encode())}.{s}"
    res = verify_vc(forged, issuer.public_key, now=NOW)
    assert res["checks"]["signature"] is False
    assert res["checks"]["notExpired"] is True


def test_verify_requires_vc_jwt_typ(vc_params):
    _, p, s = issue_vc(**vc_params).split(".")
    h = b64url_encode(b'{"alg":"EdDSA","typ":"vp+jwt"}')
    assert verify_vc(f"{h}.{p}.{s}", issuer.public_key, now=NOW)["checks"]["signature"] is False


def test_verify_garbage():
    with pytest.raises(VcError):
        verify_vc("garbage", issuer.public_key)
