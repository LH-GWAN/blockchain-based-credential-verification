"""발급기관 핵심 로직 (HTTP 와 분리)."""
from __future__ import annotations

import logging
import random
import time
import uuid
from datetime import datetime, timedelta, timezone

from dbp_rules import bundle_hash, evaluate_claims, load_bundle
from dbp_rules.bundle import schema_hash
from dbp_vc import (
    create_status_list, decode_status_list, encode_status_list, generate_holder_key, get_status, issue_vc,
    random_salt, receipt_hash, set_status, verify_jws, did_key_to_public_key,
)

from .config import Settings
from .datasource import IssuerDataSource
from .db import Store
from .ledger_iface import Ledger

log = logging.getLogger("dbp_issuer")
STATUS_LIST_BITS = 131072
KIND_CONSENT = 1


class IssuerService:
    def __init__(self, settings: Settings, store: Store, ledger: Ledger | None, datasource: IssuerDataSource):
        self.s = settings
        self.store = store
        self.ledger = ledger
        self.ds = datasource
        self.key = generate_holder_key(settings.ed25519_seed)  # 발급기관 서명키 (HolderKey 구조 재사용: private_key / public_key)
        self.bundle = load_bundle(settings.bundle, settings.version)
        self.bundle_hash = bundle_hash(self.bundle)
        self.schema_hash = schema_hash()
        self.my_claims = [c for c, iss in self.bundle["claims"]["issuerOf"].items() if iss == settings.did]
        self.labels = self.bundle["claims"]["labels"]
        self.challenges: dict[str, tuple[str, float]] = {}  # nonce -> (holderDid, exp)
        self._ensure_status_list()

    # ---------- 상태 목록 ----------
    def _ensure_status_list(self) -> None:
        row = self.store.get_status_list(self.s.status_list_id)
        if row is None:
            bits = bytes(create_status_list(STATUS_LIST_BITS))
            self.store.put_status_list(self.s.status_list_id, bits, 1)
            row = (bits, 1)
        self._sync_status_list_to_ledger(*row)

    def _sync_status_list_to_ledger(self, bits: bytes, version: int) -> str | None:
        if not self.ledger or not self.ledger.is_connected():
            return None
        try:
            cur = self.ledger.get_status_list(self.s.status_list_id)
            if int(cur["version"]) >= version:
                return None
        except Exception:
            pass
        try:
            return self.ledger.publish_status_list(self.s.status_list_id, encode_status_list(bytearray(bits)), version)
        except Exception as e:  # 원장이 없어도 발급은 계속되지만 로그를 남긴다
            log.warning("status list publish failed: %s", e)
            return None

    def status_list_info(self) -> dict:
        bits, version = self.store.get_status_list(self.s.status_list_id)
        return {"listId": self.s.status_list_id, "version": version, "encoded": encode_status_list(bytearray(bits))}

    def _alloc_index(self) -> int:
        used = self.store.used_indices()
        while True:
            i = random.SystemRandom().randrange(0, STATUS_LIST_BITS)
            if i not in used:
                return i

    # ---------- 규칙 해시 대조 ----------
    def check_bundle_on_ledger(self) -> tuple[bool, str]:
        if not self.ledger or not self.ledger.is_connected():
            return (self.s.ledger_optional, "LEDGER_UNAVAILABLE")
        try:
            on = self.ledger.get_bundle(self.s.bundle, self.s.version)
        except Exception as e:
            return (self.s.ledger_optional, f"BUNDLE_NOT_REGISTERED:{e}")
        return (on["bundleHash"].lower() == self.bundle_hash.lower(), "RULE_HASH_MISMATCH")

    # ---------- 홀더 증명 ----------
    def new_challenge(self, holder_did: str) -> dict:
        nonce = uuid.uuid4().hex
        exp = time.time() + 300
        self.challenges[nonce] = (holder_did, exp)
        return {"nonce": nonce, "exp": int(exp), "aud": self.s.did}

    def verify_holder_proof(self, holder_did: str, proof_jws: str) -> None:
        pub = did_key_to_public_key(holder_did)
        header, payload = verify_jws(proof_jws, pub)
        nonce = payload.get("nonce")
        ent = self.challenges.pop(nonce, None)
        if not ent or ent[0] != holder_did or ent[1] < time.time():
            raise PermissionError("HOLDER_PROOF_INVALID")
        if payload.get("iss") != holder_did or payload.get("aud") != self.s.did:
            raise PermissionError("HOLDER_PROOF_INVALID")

    # ---------- 발급 ----------
    def issue(self, citizen_id: str, holder_did: str, requested: list[str], consent_ts: str) -> dict:
        record = self.ds.get_record(citizen_id)
        if record is None:
            raise LookupError("CITIZEN_UNKNOWN")
        bad = [c for c in requested if c not in self.my_claims]
        if bad:
            raise ValueError(f"CLAIM_NOT_ISSUED_HERE:{','.join(bad)}")
        ok, reason = self.check_bundle_on_ledger()
        if not ok:
            raise RuntimeError(reason)

        results = evaluate_claims(self.bundle, record, only=requested)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        valid_from = now.isoformat().replace("+00:00", "Z")
        valid_until = (now + timedelta(days=self.s.vc_valid_days)).isoformat().replace("+00:00", "Z")
        credentials, denied = [], []
        for claim in requested:
            if results[claim] is not True:
                denied.append({"claim": claim, "label": self.labels[claim], "reason": "규칙 기준 미충족",
                               "ruleRef": {"bundle": self.s.bundle, "version": self.s.version, "claim": claim}})
                continue
            idx = self._alloc_index()
            jti = f"urn:uuid:{uuid.uuid4()}"
            jwt = issue_vc(
                id=jti, issuer_did=self.s.did, issuer_kid=self.s.kid, issuer_private_key=self.key.private_key,
                holder_did=holder_did, claim={"name": claim, "value": True},
                valid_from=valid_from, valid_until=valid_until,
                status={"listId": self.s.status_list_id, "index": idx},
                evidence={"bundle": self.s.bundle, "version": self.s.version, "bundleHash": self.bundle_hash},
            )
            self.store.add_credential(jti, holder_did, claim, idx, valid_from, valid_until)
            credentials.append({"jti": jti, "claim": claim, "label": self.labels[claim], "vcJwt": jwt,
                                "statusListIndex": idx, "validUntil": valid_until})

        # 동의 영수증: 원문+솔트는 홀더가 보관, 원장에는 해시만
        salt = random_salt()
        receipt_obj = {"kind": "consent", "holderDid": holder_did, "issuerDid": self.s.did,
                       "claims": sorted(requested), "ts": consent_ts, "salt": salt}
        h = receipt_hash(receipt_obj)
        tx = None
        if self.ledger and self.ledger.is_connected():
            try:
                tx = self.ledger.anchor_receipt(h, KIND_CONSENT)
            except Exception as e:
                log.warning("consent receipt anchor failed: %s", e)
        self.store.add_receipt(h, KIND_CONSENT, tx)
        return {
            "issuer": {"did": self.s.did, "name": self.s.name},
            "credentials": credentials, "denied": denied,
            "consentReceipt": {"hash": h, "txHash": tx, "object": receipt_obj},
            "bundle": {"bundle": self.s.bundle, "version": self.s.version, "bundleHash": self.bundle_hash},
        }

    # ---------- 폐기 ----------
    def revoke(self, jti: str) -> dict:
        cred = self.store.get_credential(jti)
        if not cred:
            raise LookupError("CREDENTIAL_UNKNOWN")
        bits, version = self.store.get_status_list(self.s.status_list_id)
        arr = bytearray(bits)
        set_status(arr, int(cred["status_index"]), True)
        version += 1
        self.store.put_status_list(self.s.status_list_id, bytes(arr), version)
        self.store.mark_revoked(jti)
        tx = self._sync_status_list_to_ledger(bytes(arr), version)
        return {"jti": jti, "statusListIndex": int(cred["status_index"]), "revoked": True,
                "statusListVersion": version, "txHash": tx}

    def is_revoked_locally(self, index: int) -> bool:
        bits, _ = self.store.get_status_list(self.s.status_list_id)
        return get_status(bytearray(bits), index)

    def reset_demo(self) -> dict:
        self.store.clear_credentials()
        _, version = self.store.get_status_list(self.s.status_list_id)
        bits = bytes(create_status_list(STATUS_LIST_BITS))
        version += 1
        self.store.put_status_list(self.s.status_list_id, bits, version)
        tx = self._sync_status_list_to_ledger(bits, version)
        return {"reset": True, "statusListVersion": version, "txHash": tx}

    def well_known(self) -> dict:
        return {
            "did": self.s.did, "name": self.s.name, "kid": self.s.kid,
            "ed25519PublicKeyHex": self.key.public_key.hex(),
            "claims": [{"claim": c, "label": self.labels[c]} for c in self.my_claims],
            "bundle": {"bundle": self.s.bundle, "version": self.s.version, "bundleHash": self.bundle_hash,
                       "schemaHash": self.schema_hash},
            "statusListId": self.s.status_list_id,
            "ledgerConnected": bool(self.ledger and self.ledger.is_connected()),
        }
