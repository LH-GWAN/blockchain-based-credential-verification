import base58
import pytest
from dbp_vc import (
    VcError,
    did_key_to_public_key,
    ed25519_public_key,
    ed25519_public_key_hex,
    ed25519_sign,
    ed25519_verify,
    generate_holder_key,
    public_key_to_did_key,
)

from .conftest import HOLDER_SEED

# RFC 8032 §7.1 TEST 1
RFC_SK = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
RFC_PK = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
RFC_SIG = (
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)


def test_rfc8032_vector():
    assert ed25519_public_key(RFC_SK).hex() == RFC_PK
    assert ed25519_public_key_hex(RFC_SK) == "0x" + RFC_PK
    sig = ed25519_sign(b"", RFC_SK)
    assert sig.hex() == RFC_SIG
    assert ed25519_verify(sig, b"", bytes.fromhex(RFC_PK)) is True
    assert ed25519_verify(sig, b"\x01", bytes.fromhex(RFC_PK)) is False
    assert ed25519_verify(b"\x00" * 63, b"", bytes.fromhex(RFC_PK)) is False


def test_rejects_bad_private_key_length():
    with pytest.raises(VcError):
        ed25519_public_key(b"\x00" * 31)
    with pytest.raises(VcError):
        ed25519_sign(b"", b"\x00" * 64)


def test_deterministic_from_seed():
    a = generate_holder_key(HOLDER_SEED)
    b = generate_holder_key(HOLDER_SEED)
    assert a.did == b.did
    assert a.did.startswith("did:key:z6Mk")
    assert a.private_key == HOLDER_SEED
    assert len(a.public_key) == 32


def test_random_without_seed():
    a = generate_holder_key()
    b = generate_holder_key()
    assert a.did != b.did
    assert len(a.private_key) == 32


def test_roundtrip_and_fragment():
    k = generate_holder_key(HOLDER_SEED)
    assert public_key_to_did_key(k.public_key) == k.did
    assert did_key_to_public_key(k.did) == k.public_key
    assert did_key_to_public_key(k.did + "#" + k.did[8:]) == k.public_key


def test_multicodec_prefix():
    k = generate_holder_key(HOLDER_SEED)
    raw = base58.b58decode(k.did[len("did:key:z") :])
    assert raw[:2] == b"\xed\x01"
    assert raw[2:] == k.public_key


def test_rejects_malformed():
    with pytest.raises(VcError):
        did_key_to_public_key("did:dbp:daegu")
    with pytest.raises(VcError):
        did_key_to_public_key("did:key:z0OIl")
    wrong_codec = "did:key:z" + base58.b58encode(b"\xec\x01" + b"\x00" * 32).decode()
    with pytest.raises(VcError):
        did_key_to_public_key(wrong_codec)
    with pytest.raises(VcError):
        public_key_to_did_key(b"\x00" * 31)
    with pytest.raises(VcError):
        generate_holder_key(b"\x00" * 16)
