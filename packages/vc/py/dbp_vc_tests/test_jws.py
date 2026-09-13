import json

import pytest
from dbp_vc import (
    VcError,
    b64url_decode,
    b64url_encode,
    decode_jws,
    generate_holder_key,
    sign_jws,
    verify_jws,
)

from .conftest import HOLDER_SEED, OTHER_SEED

key = generate_holder_key(HOLDER_SEED)
other = generate_holder_key(OTHER_SEED)
HEADER = {"alg": "EdDSA", "typ": "vc+jwt", "kid": "did:dbp:daegu#key-1"}
PAYLOAD = {"a": 1, "k": "대구", "nested": {"ok": True}}


def test_three_segments_and_deterministic():
    jws = sign_jws(HEADER, PAYLOAD, key.private_key)
    parts = jws.split(".")
    assert len(parts) == 3
    assert "=" not in jws
    assert json.loads(b64url_decode(parts[0])) == HEADER
    assert len(b64url_decode(parts[2])) == 64
    assert sign_jws(HEADER, PAYLOAD, key.private_key) == jws


def test_verify_returns_header_and_payload():
    jws = sign_jws(HEADER, PAYLOAD, key.private_key)
    header, payload = verify_jws(jws, key.public_key)
    assert header == HEADER
    assert payload == PAYLOAD
    assert decode_jws(jws).payload == PAYLOAD


def test_rejects_tamper_wrong_key_bad_sig():
    jws = sign_jws(HEADER, PAYLOAD, key.private_key)
    h, _, s = jws.split(".")
    forged = f"{h}.{b64url_encode(json.dumps({'a': 2}).encode())}.{s}"
    for bad in (forged, jws[:-2] + "AA"):
        with pytest.raises(VcError) as e:
            verify_jws(bad, key.public_key)
        assert e.value.code == "SIG_INVALID"
    with pytest.raises(VcError, match="signature"):
        verify_jws(jws, other.public_key)


def test_rejects_malformed_and_unsupported_alg():
    with pytest.raises(VcError):
        verify_jws("a.b", key.public_key)
    with pytest.raises(VcError):
        verify_jws("not.base64url.@@", key.public_key)
    with pytest.raises(VcError, match="3 segments"):
        decode_jws("x.y.z.w")
    with pytest.raises(VcError):
        sign_jws({"alg": "HS256"}, PAYLOAD, key.private_key)
    none_header = b64url_encode(b'{"alg":"none"}')
    _, p, s = sign_jws(HEADER, PAYLOAD, key.private_key).split(".")
    with pytest.raises(VcError, match="alg"):
        verify_jws(f"{none_header}.{p}.{s}", key.public_key)


def test_b64url_helpers():
    assert b64url_encode(b"\xfb\xff\xfe") == "-__-"
    assert b64url_decode("-__-") == b"\xfb\xff\xfe"
    with pytest.raises(ValueError):
        b64url_decode("+/+/")
