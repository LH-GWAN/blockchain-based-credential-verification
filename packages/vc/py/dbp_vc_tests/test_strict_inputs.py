"""F67·F68: TS 와 같은 입력만 받는지 — fixtures/strict-inputs.json 을 TS 테스트(strict-inputs.test.ts)와 공유한다."""

import json

import pytest
from dbp_vc import (
    VcError,
    b64url_decode,
    b64url_encode,
    canonicalize,
    decode_jws,
    did_key_to_public_key,
    ed25519_is_valid_public_key,
    ed25519_verify,
    generate_holder_key,
    sign_jws,
    verify_jws,
    verify_vp,
)

from .conftest import FIXTURES_DIR, HOLDER_SEED

V = json.loads((FIXTURES_DIR / "strict-inputs.json").read_text(encoding="utf-8"))
MSG = V["messageUtf8"].encode("utf-8")
VERIFIER_DID = "did:dbp:verifier:test"


@pytest.mark.parametrize("case", V["ed25519"], ids=lambda c: c["name"])
def test_ed25519_vectors(case):
    pk = bytes.fromhex(case["publicKeyHex"])
    sig = bytes.fromhex(case["signatureHex"])
    assert ed25519_is_valid_public_key(pk) is case["validKey"]
    assert ed25519_verify(sig, MSG, pk) is case["verify"]


def test_identity_key_forgery_is_rejected_for_any_message():
    # 항등원 공개키 + (R=항등원, S=0) — 예전에는 OpenSSL 이 어떤 메시지에도 통과시켰다 (F67)
    identity = bytes([1]) + bytes(31)
    forged = identity + bytes(32)
    for msg in (b"", b"dbp", b"any other verifier"):
        assert ed25519_verify(forged, msg, identity) is False


def test_identity_did_cannot_present_a_vp():
    identity_did = V["didKey"]["invalid"][0]
    header = b64url_encode(json.dumps({"alg": "EdDSA", "typ": "vp+jwt"}).encode())
    payload = b64url_encode(
        json.dumps(
            {
                "iss": identity_did,
                "aud": VERIFIER_DID,
                "nonce": "n_x",
                "iat": 1789376400,
                "vp": {"verifiableCredential": []},
            }
        ).encode()
    )
    sig = b64url_encode(bytes([1]) + bytes(63))
    with pytest.raises(VcError) as e:
        verify_vp(f"{header}.{payload}.{sig}", VERIFIER_DID)
    assert e.value.code == "VP_SIG_INVALID"


@pytest.mark.parametrize("did", V["didKey"]["valid"])
def test_did_key_valid(did):
    assert len(did_key_to_public_key(did)) == 32


@pytest.mark.parametrize("did", V["didKey"]["invalid"])
def test_did_key_invalid(did):
    with pytest.raises(VcError) as e:
        did_key_to_public_key(did)
    assert e.value.code == "MALFORMED"


def test_did_key_rejects_non_string():
    with pytest.raises(VcError):
        did_key_to_public_key(None)  # type: ignore[arg-type]


def test_b64url_canonical_only():
    canon = V["base64url"]["canonical"]
    assert len(b64url_decode(canon)) == 64
    for bad in V["base64url"]["nonCanonical"]:
        with pytest.raises(ValueError):
            b64url_decode(bad)
    with pytest.raises(ValueError):
        b64url_decode("A")  # 길이 4n+1


def test_jws_signature_variants_are_malformed():
    # 같은 서명 바이트로 디코딩되는 마지막 글자 변형은 거부된다 (vpHash 가 변형마다 달라지는 문제, F68)
    key = generate_holder_key(HOLDER_SEED)
    jws = sign_jws({"alg": "EdDSA", "typ": "vp+jwt"}, {"a": 1}, key.private_key)
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    i = alphabet.index(jws[-1])
    variants = [jws[:-1] + alphabet[i + d] for d in range(1, 16)]
    for v in variants:
        with pytest.raises(VcError) as e:
            verify_jws(v, key.public_key)
        assert e.value.code == "MALFORMED"
    assert verify_jws(jws, key.public_key)[1] == {"a": 1}


@pytest.mark.parametrize(
    "raw",
    [
        b'{"alg":"EdDSA","x":NaN}',
        b'{"alg":"EdDSA","x":Infinity}',
        b'{"alg":"EdDSA","x":-Infinity}',
        b'\xef\xbb\xbf{"alg":"EdDSA"}',  # BOM
        b'{"alg":"EdDSA","x":"\xff"}',  # 깨진 UTF-8
    ],
)
def test_jws_segment_json_is_strict(raw):
    with pytest.raises(VcError) as e:
        decode_jws(f"{b64url_encode(raw)}.{b64url_encode(b'{}')}.")
    assert e.value.code == "MALFORMED"


@pytest.mark.parametrize("case", V["jcs"]["reject"], ids=lambda c: c["json"])
def test_jcs_rejects(case):
    with pytest.raises(VcError) as e:
        canonicalize(json.loads(case["json"]))
    assert e.value.code == case["code"]


@pytest.mark.parametrize("case", V["jcs"]["accept"], ids=lambda c: c["json"])
def test_jcs_accepts(case):
    assert canonicalize(json.loads(case["json"])) == case["canonical"]


def test_jcs_safe_integer_bounds():
    assert canonicalize([2**53 - 1, -(2**53 - 1)]) == "[9007199254740991,-9007199254740991]"
    for bad in (2**53, -(2**53), 10**30):
        with pytest.raises(VcError) as e:
            canonicalize({"n": bad})
        assert e.value.code == "FLOAT_FORBIDDEN"
