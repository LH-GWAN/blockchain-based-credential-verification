"""관리 API 보호(F10)·폐기 원장 게시 실패 처리(F07)·일괄 폐기와 고시 연동 유효기간(F43)·직렬화(F61)·
앵커 비동기(F62)·입력 검증(F63)·기준일 공개(F65)."""
import sqlite3
import threading
import time
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from dbp_rules import bundle_hash, load_bundle
from dbp_vc import (
    create_status_list, decode_status_list, decode_vc, encode_status_list, generate_holder_key, get_status, set_status,
    sign_jws,
)

from dbp_issuer.app import create_app
from dbp_issuer.config import Settings
from dbp_issuer.db import Store
from dbp_issuer.ledger_iface import FakeLedger
from dbp_issuer.service import STATUS_LIST_BITS, vc_valid_until

REQ = ["daeguResident", "ageOver65"]  # C-001 이 둘 다 충족


class FlakyLedger(FakeLedger):
    """게시 실패·지연을 흉내 내는 원장."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.fail_publish = False
        self.fail_anchor = False
        self.publish_delay = 0.0
        self.publish_calls = 0

    def publish_status_list(self, list_id, encoded_list, version):
        self.publish_calls += 1
        if self.fail_publish:
            raise RuntimeError("rpc timeout")
        if self.publish_delay:
            cur = self.status_lists.get(list_id)
            time.sleep(self.publish_delay)  # 읽기-쓰기 사이에 다른 요청이 끼어들 틈
            if cur is not self.status_lists.get(list_id):
                raise RuntimeError("concurrent publish")
        return super().publish_status_list(list_id, encoded_list, version)

    def anchor_receipt(self, salted_hash, kind):
        if self.fail_anchor:
            raise RuntimeError("block production stalled")
        return super().anchor_receipt(salted_hash, kind)


class OfflineLedger(FakeLedger):
    def is_connected(self) -> bool:
        return False


def _ledger(cls=FlakyLedger):
    return cls(bundle_hash(load_bundle()))


def _app(tmp_path, ledger, issuer_id="daegu", client=("testclient", 50000), db="issuer.db", **settings_kw):
    settings = Settings(issuer_id=issuer_id, db_path=str(tmp_path / db), **settings_kw)
    app = create_app(settings, ledger=ledger, store=Store(settings.db_path))
    return TestClient(app, client=client), settings


@pytest.fixture(autouse=True)
def _eval_date(monkeypatch):
    monkeypatch.setenv("RULE_EVAL_DATE", "2026-09-14")
    for k in ("ADMIN_TOKEN", "HOST", "ALLOWED_ORIGINS"):
        monkeypatch.delenv(k, raising=False)


def _issue(client, claims=REQ, citizen="C-001"):
    holder = generate_holder_key()
    ch = client.post("/credentials/challenge", json={"holderDid": holder.did}).json()
    proof = sign_jws(header={"alg": "EdDSA", "typ": "holder-proof+jwt"},
                     payload={"iss": holder.did, "aud": ch["aud"], "nonce": ch["nonce"]}, private_key=holder.private_key)
    return client.post("/credentials/issue", json={
        "citizenId": citizen, "holderDid": holder.did, "holderProof": proof,
        "requestedClaims": claims, "consent": {"scope": sorted(set(claims)), "ts": "2026-09-14T09:00:00Z"},
    })


def _ledger_bits(ledger, settings):
    return decode_status_list(ledger.status_lists[settings.status_list_id]["encodedList"])


# ---------- F10 관리 API 보호 ----------
def test_admin_allows_loopback_without_token(tmp_path):
    client, _ = _app(tmp_path, _ledger())
    assert client.get("/admin/credentials").status_code == 200
    local, _ = _app(tmp_path, _ledger(), client=("127.0.0.1", 50000), db="local.db")
    assert local.get("/admin/credentials").status_code == 200


def test_admin_rejects_lan_client_without_token(tmp_path):
    client, _ = _app(tmp_path, _ledger(), client=("192.168.0.23", 50000))
    for method, path in [("get", "/admin/credentials"), ("post", "/admin/demo/reset"),
                         ("post", "/admin/credentials/urn:uuid:x/revoke"), ("post", "/admin/status-list/resync")]:
        r = getattr(client, method)(path)
        assert r.status_code == 403 and r.json()["detail"] == "ADMIN_FORBIDDEN", path
    # 공개 API 는 그대로
    assert client.get("/.well-known/issuer").status_code == 200


def test_admin_rejects_cross_site_browser_request(tmp_path):
    """루프백이라도 다른 사이트에서 보낸 브라우저 요청(CSRF)은 거른다. 같은 출처 /docs 와 Origin 없는 도구 요청은 통과."""
    client, _ = _app(tmp_path, _ledger())
    for headers in [{"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}]:
        r = client.post("/admin/demo/reset", headers=headers)
        assert r.status_code == 403 and r.json()["detail"] == "ADMIN_FORBIDDEN", headers
    same = client.get("/admin/credentials", headers={"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"})
    assert same.status_code == 200
    assert client.get("/admin/credentials").status_code == 200


def test_admin_token_required_when_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", "s3cret-demo")
    client, _ = _app(tmp_path, _ledger(), client=("172.18.0.1", 50000))
    assert client.get("/admin/credentials").status_code == 403
    assert client.get("/admin/credentials", headers={"X-Admin-Token": "nope"}).status_code == 403
    assert client.get("/admin/credentials", headers={"X-Admin-Token": "s3cret-demo"}).status_code == 200
    # 토큰이 설정되면 루프백이어도 토큰이 필요하다
    local, _ = _app(tmp_path, _ledger(), client=("127.0.0.1", 1), db="local.db")
    assert local.get("/admin/credentials").status_code == 403


def test_admin_list_hides_holder_and_index(tmp_path):
    client, _ = _app(tmp_path, _ledger())
    assert _issue(client).status_code == 200
    body = client.get("/admin/credentials").json()
    assert body["credentials"] and all(
        set(c) == {"jti", "claim", "issued_at", "valid_until", "revoked"} for c in body["credentials"])
    assert body["byClaim"] == {"daeguResident": 1, "ageOver65": 1}
    assert body["statusList"]["pendingPublish"] is False
    text = str(body)
    assert "did:key" not in text and "status_index" not in text and "holder" not in text.lower()


def test_cors_and_host_defaults(tmp_path, monkeypatch):
    s = Settings(issuer_id="daegu", db_path=str(tmp_path / "x.db"))
    assert s.host == "127.0.0.1" and "http://localhost:3000" in s.allowed_origins and "*" not in s.allowed_origins
    monkeypatch.setenv("HOST", "0.0.0.0")
    monkeypatch.setenv("ALLOWED_ORIGINS", "http://wallet.test:3000, http://verifier.test:3001")
    s = Settings(issuer_id="daegu", db_path=str(tmp_path / "x.db"))
    assert s.host == "0.0.0.0" and s.allowed_origins == ["http://wallet.test:3000", "http://verifier.test:3001"]
    monkeypatch.delenv("ALLOWED_ORIGINS")
    client, _ = _app(tmp_path, _ledger())
    ok = client.get("/.well-known/issuer", headers={"Origin": "http://localhost:3010"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3010"
    bad = client.get("/.well-known/issuer", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in bad.headers


def test_reset_keeps_status_bits_on_ledger(tmp_path):
    ledger = _ledger()
    client, settings = _app(tmp_path, ledger)
    jti = _issue(client).json()["credentials"][0]["jti"]
    rv = client.post(f"/admin/credentials/{jti}/revoke").json()
    before = ledger.status_lists[settings.status_list_id]["version"]
    r = client.post("/admin/demo/reset").json()
    assert r["reset"] is True
    assert ledger.status_lists[settings.status_list_id]["version"] == before  # 원장에 0 목록을 게시하지 않는다
    assert get_status(_ledger_bits(ledger, settings), rv["statusListIndex"]) is True
    assert client.app.state.svc.is_revoked_locally(rv["statusListIndex"]) is True
    assert client.get("/admin/credentials").json()["credentials"] == []


def test_alloc_index_skips_revoked_bits(tmp_path):
    client, settings = _app(tmp_path, _ledger())
    svc = client.app.state.svc
    bits = bytearray(b"\xff" * (STATUS_LIST_BITS // 8))
    set_status(bits, 42, False)
    svc.store.put_status_list(settings.status_list_id, bytes(bits), 5)
    assert svc._alloc_index() == 42


# ---------- F07 원장 게시 실패 ----------
def test_revoke_publish_failure_is_503_and_resync_publishes(tmp_path):
    ledger = _ledger()
    client, settings = _app(tmp_path, ledger)
    cred = _issue(client).json()["credentials"][0]
    ledger.fail_publish = True
    r = client.post(f"/admin/credentials/{cred['jti']}/revoke")
    assert r.status_code == 503 and r.json()["detail"] == "LEDGER_PUBLISH_FAILED"
    svc = client.app.state.svc
    assert svc.is_revoked_locally(cred["statusListIndex"]) is True  # 로컬은 폐기 유지
    assert get_status(_ledger_bits(ledger, settings), cred["statusListIndex"]) is False
    assert client.get("/admin/credentials").json()["statusList"]["pendingPublish"] is True
    ledger.fail_publish = False
    rs = client.post("/admin/status-list/resync")
    assert rs.status_code == 200 and rs.json()["txHash"]
    assert get_status(_ledger_bits(ledger, settings), cred["statusListIndex"]) is True
    assert client.get("/admin/credentials").json()["statusList"]["pendingPublish"] is False


def test_revoke_without_ledger_is_503(tmp_path):
    client, _ = _app(tmp_path, _ledger(OfflineLedger), ledger_optional=True)
    issued = _issue(client)
    assert issued.status_code == 200
    assert issued.json()["consentReceipt"]["anchor"] == "skipped"
    r = client.post(f"/admin/credentials/{issued.json()['credentials'][0]['jti']}/revoke")
    assert r.status_code == 503 and r.json()["detail"] == "LEDGER_PUBLISH_FAILED"


def test_revoke_merges_when_ledger_is_ahead(tmp_path):
    """DB 만 초기화된 경우(로컬 v < 원장 v): 원장 비트와 OR 하고 원장 version + 1 로 게시한다."""
    ledger = _ledger()
    client, settings = _app(tmp_path, ledger)
    cred = _issue(client).json()["credentials"][0]
    other = bytearray(create_status_list(STATUS_LIST_BITS))
    set_status(other, 7, True)
    ledger.status_lists[settings.status_list_id] = {"encodedList": encode_status_list(other), "version": 9,
                                                    "updatedAt": 0, "owner": "0x0"}
    rv = client.post(f"/admin/credentials/{cred['jti']}/revoke")
    assert rv.status_code == 200 and rv.json()["statusListVersion"] == 10 and rv.json()["txHash"]
    bits = _ledger_bits(ledger, settings)
    assert get_status(bits, 7) and get_status(bits, cred["statusListIndex"])
    assert client.app.state.svc.is_revoked_locally(7) is True


def test_startup_merges_failed_publish_from_previous_run(tmp_path):
    ledger = _ledger()
    client, settings = _app(tmp_path, ledger)
    cred = _issue(client).json()["credentials"][0]
    ledger.fail_publish = True
    assert client.post(f"/admin/credentials/{cred['jti']}/revoke").status_code == 503
    ledger.fail_publish = False
    # 재기동: 같은 DB, 같은 원장 → 미게시분이 게시된다
    create_app(settings, ledger=ledger, store=Store(settings.db_path))
    assert get_status(_ledger_bits(ledger, settings), cred["statusListIndex"]) is True


# ---------- F61 직렬화 ----------
def test_concurrent_revokes_keep_both_bits(tmp_path):
    ledger = _ledger()
    client, settings = _app(tmp_path, ledger)
    creds = _issue(client).json()["credentials"]
    assert len(creds) == 2
    ledger.publish_delay = 0.05
    svc = client.app.state.svc
    errors: list[Exception] = []

    def run(jti):
        try:
            svc.revoke(jti)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=run, args=(c["jti"],)) for c in creds]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert errors == []
    bits = _ledger_bits(ledger, settings)
    assert all(get_status(bits, c["statusListIndex"]) for c in creds)


# ---------- F43 일괄 폐기·고시 연동 유효기간 ----------
def test_revoke_by_bundle_single_publish(tmp_path):
    ledger = _ledger()
    client, settings = _app(tmp_path, ledger)
    creds = _issue(client).json()["credentials"] + _issue(client, ["daeguResident"]).json()["credentials"]
    assert len(creds) == 3
    calls = ledger.publish_calls
    r = client.post("/admin/credentials/revoke-by-bundle", json={"bundle": "daegu-eligibility", "version": "2026.2"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revoked"] == 3 and body["txHash"] and ledger.publish_calls == calls + 1
    bits = _ledger_bits(ledger, settings)
    assert all(get_status(bits, c["statusListIndex"]) for c in creds)
    assert all(c["revoked"] for c in client.get("/admin/credentials").json()["credentials"])
    again = client.post("/admin/credentials/revoke-by-bundle", json={"bundle": "daegu-eligibility", "version": "2026.2"})
    assert again.json()["revoked"] == 0 and again.json()["txHash"] is None
    other = client.post("/admin/credentials/revoke-by-bundle", json={"bundle": "daegu-eligibility", "version": "2026.1"})
    assert other.json()["revoked"] == 0


def test_revoke_by_bundle_requires_admin(tmp_path):
    client, _ = _app(tmp_path, _ledger(), client=("10.0.0.9", 1))
    r = client.post("/admin/credentials/revoke-by-bundle", json={"bundle": "daegu-eligibility", "version": "2026.2"})
    assert r.status_code == 403


def test_vc_valid_until_follows_median_income_year():
    assert vc_valid_until(datetime(2026, 10, 9, tzinfo=UTC), 365, 2026) == datetime(2026, 12, 31, 14, 59, 59, tzinfo=UTC)
    early = datetime(2025, 6, 1, tzinfo=UTC)
    assert vc_valid_until(early, 365, 2026) == datetime(2026, 6, 1, tzinfo=UTC)


def test_issued_vc_expires_at_bundle_year_end(tmp_path):
    client, _ = _app(tmp_path, _ledger())
    client.app.state.svc.now = lambda: datetime(2026, 10, 22, 1, 0, tzinfo=UTC)
    cred = _issue(client).json()["credentials"][0]
    assert cred["validUntil"] == "2026-12-31T14:59:59Z"
    assert decode_vc(cred["vcJwt"])["vc"]["validUntil"] == "2026-12-31T14:59:59Z"
    client.app.state.svc.now = lambda: datetime(2027, 1, 2, tzinfo=UTC)
    r = _issue(client)
    assert r.status_code == 503 and r.json()["detail"] == "BUNDLE_PERIOD_ENDED"


def test_existing_db_is_migrated_in_place(tmp_path):
    p = tmp_path / "old.db"
    c = sqlite3.connect(p)
    c.executescript("""
    CREATE TABLE credentials (jti TEXT PRIMARY KEY, holder_did TEXT NOT NULL, claim TEXT NOT NULL,
      status_index INTEGER NOT NULL UNIQUE, issued_at INTEGER NOT NULL, valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER);
    CREATE TABLE status_list (list_id TEXT PRIMARY KEY, bits BLOB NOT NULL, version INTEGER NOT NULL);
    INSERT INTO credentials VALUES ('urn:uuid:old', 'did:key:z', 'daeguResident', 5, 1, 'a', 'b', 0, NULL);
    INSERT INTO status_list VALUES ('dbp:status:daegu:list-1', x'00', 3);
    """)
    c.commit()
    c.close()
    store = Store(str(p))
    old = store.get_credential("urn:uuid:old")
    assert old["bundle"] is None and old["bundle_version"] is None
    assert store.status_list_dirty("dbp:status:daegu:list-1") is False
    assert store.get_status_list("dbp:status:daegu:list-1") == (b"\x00", 3)
    Store(str(p))  # 두 번 열어도 안전


# ---------- F62 앵커 비동기 ----------
def test_issue_succeeds_when_consent_anchor_fails(tmp_path):
    ledger = _ledger()
    ledger.fail_anchor = True
    client, _ = _app(tmp_path, ledger)
    r = _issue(client)
    assert r.status_code == 200 and len(r.json()["credentials"]) == 2
    h = r.json()["consentReceipt"]["hash"]
    assert h not in ledger.receipts
    assert client.get(f"/consent-receipts/{h}").json() == {"hash": h, "txHash": None, "anchor": "pending"}
    assert client.get("/consent-receipts/0xdead").status_code == 404


def test_issue_reports_ledger_outage_not_unregistered_bundle(tmp_path):
    """원장 일시 장애(LedgerUnavailable)는 '번들 미등록'이 아니라 LEDGER_UNAVAILABLE 로 알린다."""
    from dbp_issuer.service import LedgerUnavailable

    class DownLedger(FakeLedger):
        def get_bundle(self, bundle, version):
            raise LedgerUnavailable("read timeout")

    client, _ = _app(tmp_path, DownLedger(bundle_hash(load_bundle())))
    r = _issue(client)
    assert r.status_code == 503 and r.json()["detail"].startswith("LEDGER_UNAVAILABLE"), r.json()


# ---------- F63 입력 검증 ----------
def test_empty_or_duplicate_claims_rejected(tmp_path):
    client, _ = _app(tmp_path, _ledger())
    for claims in ([], ["daeguResident", "daeguResident"]):
        r = _issue(client, claims)
        assert r.status_code == 400 and r.json()["detail"] == "CLAIMS_INVALID", claims
    assert client.get("/admin/credentials").json()["credentials"] == []


def test_status_list_full_is_503(tmp_path, monkeypatch):
    client, _ = _app(tmp_path, _ledger())
    svc = client.app.state.svc
    monkeypatch.setattr(svc.store, "used_indices", lambda: set(range(STATUS_LIST_BITS)))
    r = _issue(client, ["daeguResident"])
    assert r.status_code == 503 and r.json()["detail"] == "STATUS_LIST_FULL"


def test_expired_challenges_are_purged(tmp_path):
    client, _ = _app(tmp_path, _ledger())
    svc = client.app.state.svc
    svc.challenges["stale"] = ("did:key:x", time.time() - 1)
    client.post("/credentials/challenge", json={"holderDid": "did:key:y"})
    assert "stale" not in svc.challenges and len(svc.challenges) == 1


# ---------- F65 기준일 공개 ----------
def test_well_known_exposes_eval_date(tmp_path, monkeypatch):
    client, _ = _app(tmp_path, _ledger())
    assert client.get("/.well-known/issuer").json()["bundle"]["evalDate"] == "2026-09-14"
    monkeypatch.setenv("RULE_EVAL_DATE", "2026-10-22")
    assert client.get("/.well-known/issuer").json()["bundle"]["evalDate"] == "2026-10-22"


def test_ledger_deployment_prefers_loaded_deployment(monkeypatch, tmp_path):
    """F17: 기동 때 원장 클라이언트가 읽은 배포 정보를 돌려준다 — 다른 스택이 latest.json 을 덮어써도 바뀌지 않는다."""
    from dbp_ledger import Deployment

    other = tmp_path / "latest.json"
    other.write_text('{"chainId": 999, "contracts": {"RuleRegistry": {"address": "0xOTHER", "abi": []}}}')
    monkeypatch.setenv("DEPLOYMENT_FILE", str(other))

    class _Loaded:
        deployment = Deployment(chain_id=31337, rpc_url="", contracts={"RuleRegistry": {"address": "0xLOADED", "abi": []}})

        def is_connected(self) -> bool:
            return False

    settings = Settings(issuer_id="daegu", db_path=str(tmp_path / "issuer.db"))
    app = create_app(settings, ledger=_Loaded(), store=Store(settings.db_path))
    body = TestClient(app).get("/ledger/deployment").json()
    assert body["chainId"] == 31337
    assert body["contracts"]["RuleRegistry"]["address"] == "0xLOADED"


def test_empty_env_falls_back_to_defaults(monkeypatch):
    """빈 ALLOWED_ORIGINS·HOST 는 '설정 안 됨' — 기본 출처·루프백을 쓴다."""
    from dbp_issuer.config import DEFAULT_ALLOWED_ORIGINS
    monkeypatch.setenv("ALLOWED_ORIGINS", "")
    monkeypatch.setenv("HOST", "")
    s = Settings()
    assert s.allowed_origins == DEFAULT_ALLOWED_ORIGINS.split(",")
    assert s.host == "127.0.0.1"
