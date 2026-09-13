"""크로스언어 픽스처 검증. 핵심은 TS(@dbp/vc)가 만든 fixtures/ts/* 를 Python이 검증하는 것이며,
같은 코드로 자체 픽스처(fixtures/py/*)도 검사한다. 마지막으로 두 언어의 산출물이 바이트 단위로 같은지 본다."""

import pytest
from dbp_vc import (
    bundle_hash,
    canonicalize,
    decode_status_list,
    decode_vc,
    did_key_to_public_key,
    ed25519_public_key_hex,
    generate_holder_key,
    get_status,
    public_key_to_did_key,
    sha256_hex,
    verify_jws,
    verify_vc,
    verify_vp,
)

from .conftest import FIXTURES_DIR, HOLDER_SEED, ISSUER_SEED, NOW, has_fixtures, load_fixture

LANGS = ["ts", "py"]


@pytest.mark.parametrize("lang", LANGS)
class TestFixtures:
    def test_exist(self, lang):
        assert has_fixtures(lang), f"missing {FIXTURES_DIR}/{lang}/*.json (run that language's fixture generator)"

    def test_didkey(self, lang):
        f = load_fixture(lang, "didkey.json")
        pk = bytes.fromhex(f["publicKeyHex"])
        assert public_key_to_did_key(pk) == f["did"]
        assert did_key_to_public_key(f["did"]).hex() == f["publicKeyHex"]
        assert generate_holder_key(HOLDER_SEED).did == f["did"]

    def test_jcs(self, lang):
        f = load_fixture(lang, "jcs.json")
        assert canonicalize(f["obj"]) == f["canonical"]
        assert bundle_hash(f["obj"]) == f["hash"]
        assert sha256_hex(f["canonical"]) == f["sha256"]
        assert "대구광역시" in f["canonical"]
        assert "\\u0001" in f["canonical"]

    def test_vc(self, lang):
        f = load_fixture(lang, "vc.json")
        pk = bytes.fromhex(f["issuerPublicKeyHex"][2:])
        assert f["issuerPublicKeyHex"] == ed25519_public_key_hex(ISSUER_SEED)
        res = verify_vc(f["jwt"], pk, now=NOW)
        assert res["checks"] == {"signature": True, "notExpired": True, "active": True}
        assert res["payload"] == f["payload"]
        assert decode_vc(f["jwt"])["header"] == {"alg": "EdDSA", "typ": "vc+jwt", "kid": f["issuerDid"] + "#key-1"}
        assert res["vc"]["credentialSubject"]["id"] == f["holderDid"]
        assert res["vc"]["issuer"] == f["issuerDid"]
        assert res["vc"]["credentialStatus"]["statusListIndex"] == "1042"
        wrong = generate_holder_key(HOLDER_SEED).public_key
        assert verify_vc(f["jwt"], wrong, now=NOW)["checks"]["signature"] is False

    def test_vp(self, lang):
        f = load_fixture(lang, "vp.json")
        vc = load_fixture(lang, "vc.json")
        res = verify_vp(f["jwt"], f["verifierDid"])
        holder_did, payload = res["holderDid"], res["payload"]
        assert holder_did == vc["holderDid"]
        assert payload["nonce"] == f["nonce"]
        assert payload["vp"]["verifiableCredential"] == f["vcJwts"]
        assert payload["vp"]["verifiableCredential"][0] == vc["jwt"]
        issuer_pk = bytes.fromhex(vc["issuerPublicKeyHex"][2:])
        names = []
        for vc_jwt in payload["vp"]["verifiableCredential"]:
            r = verify_vc(vc_jwt, issuer_pk, now=NOW)
            assert r["checks"] == {"signature": True, "notExpired": True, "active": True}
            assert r["vc"]["credentialSubject"]["id"] == holder_did
            names += [k for k in r["vc"]["credentialSubject"] if k != "id"]
        assert sorted(names) == ["daeguResident", "incomeBelow50Median"]
        with pytest.raises(Exception, match="aud"):
            verify_vp(f["jwt"], "did:dbp:someone-else")
        header, _ = verify_jws(f["jwt"], did_key_to_public_key(holder_did))
        assert header == {"alg": "EdDSA", "typ": "vp+jwt"}

    def test_statuslist(self, lang):
        f = load_fixture(lang, "statuslist.json")
        lst = decode_status_list(f["encoded"])
        assert len(lst) * 8 == f["size"]
        revoked = set(f["revokedIndices"])
        assert all(get_status(lst, i) == (i in revoked) for i in range(f["size"]))


@pytest.mark.skipif(not all(has_fixtures(lang) for lang in LANGS), reason="both fixture sets required")
class TestLanguagesAgree:
    def test_byte_identical_jwts(self):
        assert load_fixture("ts", "vc.json")["jwt"] == load_fixture("py", "vc.json")["jwt"]
        assert load_fixture("ts", "vp.json")["jwt"] == load_fixture("py", "vp.json")["jwt"]
        assert load_fixture("ts", "vp.json")["vcJwts"] == load_fixture("py", "vp.json")["vcJwts"]

    def test_identical_canonical_hash_did_revoked(self):
        assert load_fixture("ts", "jcs.json")["canonical"] == load_fixture("py", "jcs.json")["canonical"]
        assert load_fixture("ts", "jcs.json")["hash"] == load_fixture("py", "jcs.json")["hash"]
        assert load_fixture("ts", "didkey.json") == load_fixture("py", "didkey.json")
        assert load_fixture("ts", "statuslist.json")["revokedIndices"] == load_fixture("py", "statuslist.json")["revokedIndices"]
        # gzip 헤더(OS 바이트 등)는 구현마다 달라 encoded 문자열 자체는 같지 않아도 된다 — 디코딩 결과만 같으면 된다.
        assert decode_status_list(load_fixture("ts", "statuslist.json")["encoded"]) == decode_status_list(
            load_fixture("py", "statuslist.json")["encoded"]
        )
