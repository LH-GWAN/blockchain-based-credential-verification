import math
import time

import pytest
from dbp_vc import (
    VcError,
    create_vp,
    decode_jws,
    generate_holder_key,
    issue_vc,
    sign_jws,
    verify_vc,
    verify_vp,
)

from .conftest import (
    EVIDENCE,
    HOLDER_SEED,
    ISSUER_DID,
    ISSUER_KID,
    ISSUER_SEED,
    LIST_ID,
    NOW,
    OTHER_SEED,
    VERIFIER_DID,
)

issuer = generate_holder_key(ISSUER_SEED)
holder = generate_holder_key(HOLDER_SEED)
other = generate_holder_key(OTHER_SEED)
NONCE = "n_0123456789abcdef0123456789abcdef"


def vc_for(name: str, index: int) -> str:
    return issue_vc(
        id=f"urn:uuid:00000000-0000-4000-8000-{index:012d}",
        issuer_did=ISSUER_DID,
        issuer_kid=ISSUER_KID,
        issuer_private_key=issuer.private_key,
        holder_did=holder.did,
        claim={"name": name, "value": True},
        valid_from="2026-09-14T00:00:00Z",
        valid_until="2027-09-14T00:00:00Z",
        status={"listId": LIST_ID, "index": index},
        evidence=EVIDENCE,
    )


VC_JWTS = [vc_for("daeguResident", 1), vc_for("incomeBelow50Median", 2)]


def vp(**overrides) -> str:
    kw = {
        "holder_did": holder.did,
        "holder_private_key": holder.private_key,
        "verifier_did": VERIFIER_DID,
        "nonce": NONCE,
        "vc_jwts": VC_JWTS,
        "iat": 1789376400,
    }
    kw.update(overrides)
    return create_vp(**kw)


def code_of(fn) -> str:
    try:
        fn()
    except VcError as e:
        return e.code
    return "NO_ERROR"


def test_payload_shape():
    d = decode_jws(vp())
    assert d.header == {"alg": "EdDSA", "typ": "vp+jwt"}
    assert d.payload == {
        "iss": holder.did,
        "aud": VERIFIER_DID,
        "nonce": NONCE,
        "iat": 1789376400,
        "vp": {
            "@context": ["https://www.w3.org/ns/credentials/v2"],
            "type": ["VerifiablePresentation"],
            "verifiableCredential": VC_JWTS,
        },
    }


def test_verify_and_holder_binding():
    res = verify_vp(vp(), VERIFIER_DID)
    assert res["holderDid"] == holder.did
    assert res["payload"]["nonce"] == NONCE
    for vc_jwt in res["payload"]["vp"]["verifiableCredential"]:
        v = verify_vc(vc_jwt, issuer.public_key, now=NOW)
        assert v["checks"] == {"signature": True, "notExpired": True, "active": True}
        assert v["vc"]["credentialSubject"]["id"] == res["holderDid"]


def test_default_iat_is_now():
    iat = decode_jws(vp(iat=None)).payload["iat"]
    assert isinstance(iat, int)
    assert abs(iat - math.floor(time.time())) < 5


def test_aud_mismatch_first():
    assert code_of(lambda: verify_vp(vp(), "did:dbp:verifier-other")) == "AUD_MISMATCH"


def test_sig_invalid():
    assert code_of(lambda: verify_vp(vp(holder_private_key=other.private_key), VERIFIER_DID)) == "VP_SIG_INVALID"
    assert code_of(lambda: verify_vp(vp()[:-2] + "AA", VERIFIER_DID)) == "VP_SIG_INVALID"
    assert code_of(lambda: verify_vp(vp(holder_did="did:dbp:not-a-holder"), VERIFIER_DID)) == "VP_SIG_INVALID"


def test_missing_nonce_and_wrong_typ():
    no_nonce = sign_jws(
        {"alg": "EdDSA", "typ": "vp+jwt"},
        {"iss": holder.did, "aud": VERIFIER_DID, "iat": 1, "vp": {"verifiableCredential": []}},
        holder.private_key,
    )
    assert code_of(lambda: verify_vp(no_nonce, VERIFIER_DID)) == "NONCE_MISSING"
    wrong_typ = sign_jws(
        {"alg": "EdDSA", "typ": "vc+jwt"},
        {"iss": holder.did, "aud": VERIFIER_DID, "nonce": NONCE, "iat": 1, "vp": {"verifiableCredential": []}},
        holder.private_key,
    )
    assert code_of(lambda: verify_vp(wrong_typ, VERIFIER_DID)) == "MALFORMED"
    with pytest.raises(VcError):
        vp(nonce="")
    with pytest.raises(VcError):
        vp(iat=1.5)
