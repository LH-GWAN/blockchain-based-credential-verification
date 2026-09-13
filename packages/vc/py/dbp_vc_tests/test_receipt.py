import re

import pytest
from dbp_vc import VcError, bundle_hash, random_nonce, random_salt, receipt_hash


def test_receipt_hash_order_independent():
    consent = {
        "kind": "consent",
        "holderDid": "did:key:z6MkExample",
        "issuerDid": "did:dbp:daegu",
        "claims": ["daeguResident", "incomeBelow50Median"],
        "ts": 1789344000,
        "salt": "ab" * 32,
    }
    h = receipt_hash(consent)
    assert re.fullmatch(r"0x[0-9a-f]{64}", h)
    assert receipt_hash(dict(reversed(list(consent.items())))) == h
    assert receipt_hash({**consent, "salt": "cd" * 32}) != h
    assert h == bundle_hash(consent)


def test_rejects_float_ts():
    with pytest.raises(VcError):
        receipt_hash({"kind": "presentation", "ts": 1789344000.5})


def test_random_salt_and_nonce():
    a, b = random_salt(), random_salt()
    assert re.fullmatch(r"[0-9a-f]{64}", a)
    assert a != b
    assert re.fullmatch(r"n_[0-9a-f]{32}", random_nonce())
    assert random_nonce() != random_nonce()
