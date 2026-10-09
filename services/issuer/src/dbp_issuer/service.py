"""발급기관 핵심 로직 (HTTP 와 분리)."""
from __future__ import annotations

import logging
import random
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta, timezone

from dbp_rules import bundle_hash, evaluate_claims, load_bundle
from dbp_rules.bundle import schema_hash
from dbp_rules.engine import eval_date_from_env
from dbp_vc import (
    create_status_list, decode_status_list, did_key_to_public_key, encode_status_list, generate_holder_key, get_status,
    issue_vc, random_salt, receipt_hash, set_status, verify_jws,
)

from .config import Settings
from .datasource import IssuerDataSource
from .db import Store
from .ledger_iface import Ledger

try:  # 원장 전송 오류(타임아웃·연결 실패)와 컨트랙트 revert(미게시 목록)를 구분한다
    from dbp_ledger import LedgerUnavailable
except ImportError:  # pragma: no cover — 구버전 dbp_ledger
    class LedgerUnavailable(Exception):  # type: ignore[no-redef]
        pass

log = logging.getLogger("dbp_issuer")
STATUS_LIST_BITS = 131072
KIND_CONSENT = 1
CHALLENGE_TTL_S = 300
KST = timezone(timedelta(hours=9))


class LedgerPublishError(RuntimeError):
    """상태목록을 원장에 게시하지 못함. 로컬은 이미 반영됐고 미게시(dirty) 표시가 남아 다음 게시 때 합쳐 올린다."""

    def __init__(self, reason: str = "LEDGER_PUBLISH_FAILED"):
        super().__init__(reason)


class StatusListFull(RuntimeError):
    def __init__(self) -> None:
        super().__init__("STATUS_LIST_FULL")


def vc_valid_until(now: datetime, valid_days: int, median_income_year: int) -> datetime:
    """VC 만료 = min(발급일 + valid_days, 번들이 쓰는 기준 중위소득 고시 연도의 말일 23:59:59 KST) (F43).
    다음 해 고시가 나오면 이전 기준으로 발급된 사실이 해를 넘겨 통과하지 않는다."""
    year_end = datetime(median_income_year, 12, 31, 23, 59, 59, tzinfo=KST).astimezone(UTC)
    return min(now + timedelta(days=valid_days), year_end)


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
        self.now = lambda: datetime.now(UTC)  # 발급 시각 (테스트에서 고정)
        # 상태목록 읽기-수정-쓰기와 원장 게시를 한 줄로 세운다 (F61). 인덱스 배정은 별도 잠금 — 게시 대기 중에도 발급은 계속된다.
        self._status_lock = threading.Lock()
        self._alloc_lock = threading.Lock()
        self._ensure_status_list()

    # ---------- 상태 목록 ----------
    def _ensure_status_list(self) -> None:
        if self.store.get_status_list(self.s.status_list_id) is None:
            bits = bytes(create_status_list(STATUS_LIST_BITS))
            self.store.put_status_list(self.s.status_list_id, bits, 1, dirty=True)
        with self._status_lock:
            try:
                self._publish_locked(force=False)
            except LedgerPublishError as e:  # 원장이 없어도 기동·발급은 계속된다. 미게시분은 다음 폐기·resync 때 올린다
                log.warning("status list publish at startup failed: %s", e)

    def _publish_locked(self, force: bool) -> tuple[int, str | None]:
        """로컬 상태목록을 원장에 게시한다. 호출자는 _status_lock 을 잡고 있어야 한다 (F07·F61).

        - 원장 version ≥ 로컬 version 이면 원장 비트를 로컬에 OR 로 합치고 원장 version + 1 로 올린다
          (DB 만 초기화된 경우·이전 게시 실패 후에도 폐기가 유실되지 않는다).
        - force=False(기동 시)면 원장이 이미 같은 내용을 갖고 있을 때 게시를 건너뛴다.
        - 게시하지 못하면 dirty 표시를 남기고 LedgerPublishError.
        반환: (게시된 또는 현재 version, txHash 또는 None=게시 불필요).
        """
        list_id = self.s.status_list_id
        bits, version = self.store.get_status_list(list_id)
        dirty = self.store.status_list_dirty(list_id)
        if not self.ledger or not self.ledger.is_connected():
            self.store.set_status_list_dirty(list_id, True)
            raise LedgerPublishError()
        try:
            cur = self.ledger.get_status_list(list_id)
        except LedgerUnavailable as e:
            log.warning("status list read failed: %s", e)
            self.store.set_status_list_dirty(list_id, True)
            raise LedgerPublishError() from e
        except Exception:  # noqa: BLE001 — 미게시 목록(revert LIST_UNKNOWN / KeyError)
            cur = None
        if cur is not None:
            ledger_version = int(cur["version"])
            ledger_bits = bytes(decode_status_list(cur["encodedList"]))
            if len(ledger_bits) == len(bits):
                merged = bytes(a | b for a, b in zip(bits, ledger_bits))
            else:  # 크기가 다른 목록은 합칠 수 없다 — 로컬을 기준으로 둔다
                log.warning("ledger status list size %d != local %d", len(ledger_bits), len(bits))
                merged = bits
            if not force and not dirty and ledger_version >= version and merged == ledger_bits:
                if (merged, ledger_version) != (bits, version):
                    self.store.put_status_list(list_id, merged, ledger_version)  # 원장이 앞서 있으면 따라간다
                return ledger_version, None
            if ledger_version >= version:
                version = ledger_version + 1
            bits = merged
            self.store.put_status_list(list_id, bits, version, dirty=True)
        try:
            tx = self.ledger.publish_status_list(list_id, encode_status_list(bytearray(bits)), version)
        except Exception as e:  # 어떤 실패든 미게시로 남기고 503
            log.warning("status list publish failed: %s", e)
            self.store.set_status_list_dirty(list_id, True)
            raise LedgerPublishError() from e
        self.store.set_status_list_dirty(list_id, False)
        return version, tx

    def _revoke_indices_locked(self, indices: list[int]) -> tuple[int, str | None]:
        """로컬 비트를 세우고(version+1, dirty) 원장에 게시한다. 게시 실패 시 로컬은 폐기 상태로 남는다."""
        bits, version = self.store.get_status_list(self.s.status_list_id)
        arr = bytearray(bits)
        for i in indices:
            set_status(arr, i, True)
        version += 1
        self.store.put_status_list(self.s.status_list_id, bytes(arr), version, dirty=True)
        return self._publish_locked(force=True)

    def resync_status_list(self) -> dict:
        """미게시분을 원장에 다시 올린다 (POST /admin/status-list/resync)."""
        with self._status_lock:
            version, tx = self._publish_locked(force=True)
        return {"listId": self.s.status_list_id, "statusListVersion": version, "txHash": tx}

    def status_list_info(self) -> dict:
        bits, version = self.store.get_status_list(self.s.status_list_id)
        return {"listId": self.s.status_list_id, "version": version, "encoded": encode_status_list(bytearray(bits))}

    def _alloc_index(self) -> int:
        """무작위 인덱스. 이미 배정됐거나 비트가 서 있는 칸(데모 초기화 전 폐기분)은 피한다. 다 차면 STATUS_LIST_FULL (F63)."""
        used = self.store.used_indices()
        bits, _ = self.store.get_status_list(self.s.status_list_id)
        rng = random.SystemRandom()
        for _ in range(64):
            i = rng.randrange(0, STATUS_LIST_BITS)
            if i not in used and not get_status(bits, i):
                return i
        free = [i for i in range(STATUS_LIST_BITS) if i not in used and not get_status(bits, i)]
        if not free:
            raise StatusListFull()
        return rng.choice(free)

    # ---------- 규칙 해시 대조 ----------
    def check_bundle_on_ledger(self) -> tuple[bool, str]:
        if not self.ledger or not self.ledger.is_connected():
            return (self.s.ledger_optional, "LEDGER_UNAVAILABLE")
        try:
            on = self.ledger.get_bundle(self.s.bundle, self.s.version)
        except LedgerUnavailable:
            return (self.s.ledger_optional, "LEDGER_UNAVAILABLE")
        except Exception as e:  # noqa: BLE001
            return (self.s.ledger_optional, f"BUNDLE_NOT_REGISTERED:{e}")
        return (on["bundleHash"].lower() == self.bundle_hash.lower(), "RULE_HASH_MISMATCH")

    # ---------- 홀더 증명 ----------
    def new_challenge(self, holder_did: str) -> dict:
        now = time.time()
        for n in [n for n, (_, e) in list(self.challenges.items()) if e < now]:  # 만료된 챌린지 정리 (F63)
            self.challenges.pop(n, None)
        nonce = uuid.uuid4().hex
        exp = now + CHALLENGE_TTL_S
        self.challenges[nonce] = (holder_did, exp)
        return {"nonce": nonce, "exp": int(exp), "aud": self.s.did}

    def verify_holder_proof(self, holder_did: str, proof_jws: str) -> None:
        pub = did_key_to_public_key(holder_did)
        _header, payload = verify_jws(proof_jws, pub)
        nonce = payload.get("nonce")
        ent = self.challenges.pop(nonce, None)
        if not ent or ent[0] != holder_did or ent[1] < time.time():
            raise PermissionError("HOLDER_PROOF_INVALID")
        if payload.get("iss") != holder_did or payload.get("aud") != self.s.did:
            raise PermissionError("HOLDER_PROOF_INVALID")

    # ---------- 발급 ----------
    def issue(self, citizen_id: str, holder_did: str, requested: list[str], consent_ts: str) -> dict:
        """VC 발급. 동의 영수증의 원장 앵커는 응답에 포함하지 않는다 — 호출자가 anchor_consent_receipt 를 뒤에서 돌린다 (F62)."""
        if not requested or len(set(requested)) != len(requested):  # 빈 목록·중복 claim (F63)
            raise ValueError("CLAIMS_INVALID")
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
        now = self.now().replace(microsecond=0)
        until = vc_valid_until(now, self.s.vc_valid_days, int(self.bundle["tables"]["medianIncomeYear"]))
        if until <= now:  # 고시 연도가 끝난 번들로는 발급하지 않는다 — 새 번들 등록 필요
            raise RuntimeError("BUNDLE_PERIOD_ENDED")
        valid_from = now.isoformat().replace("+00:00", "Z")
        valid_until = until.isoformat().replace("+00:00", "Z")
        credentials, denied = [], []
        for claim in requested:
            if results[claim] is not True:
                denied.append({"claim": claim, "label": self.labels[claim], "reason": "규칙 기준 미충족",
                               "ruleRef": {"bundle": self.s.bundle, "version": self.s.version, "claim": claim}})
                continue
            jti = f"urn:uuid:{uuid.uuid4()}"
            with self._alloc_lock:  # 동시 발급이 같은 인덱스를 고르지 않도록 배정~저장을 묶는다
                idx = self._alloc_index()
                jwt = issue_vc(
                    id=jti, issuer_did=self.s.did, issuer_kid=self.s.kid, issuer_private_key=self.key.private_key,
                    holder_did=holder_did, claim={"name": claim, "value": True},
                    valid_from=valid_from, valid_until=valid_until,
                    status={"listId": self.s.status_list_id, "index": idx},
                    evidence={"bundle": self.s.bundle, "version": self.s.version, "bundleHash": self.bundle_hash},
                )
                self.store.add_credential(jti, holder_did, claim, idx, valid_from, valid_until,
                                          bundle=self.s.bundle, bundle_version=self.s.version)
            credentials.append({"jti": jti, "claim": claim, "label": self.labels[claim], "vcJwt": jwt,
                                "statusListIndex": idx, "validUntil": valid_until})

        # 동의 영수증: 원문+솔트는 홀더가 보관, 원장에는 해시만
        salt = random_salt()
        receipt_obj = {"kind": "consent", "holderDid": holder_did, "issuerDid": self.s.did,
                       "claims": sorted(requested), "ts": consent_ts, "salt": salt}
        h = receipt_hash(receipt_obj)
        self.store.add_receipt(h, KIND_CONSENT, None)
        anchoring = bool(self.ledger and self.ledger.is_connected())
        return {
            "issuer": {"did": self.s.did, "name": self.s.name},
            "credentials": credentials, "denied": denied,
            # txHash 는 앵커가 끝난 뒤 GET /consent-receipts/{hash} 로 확인한다. 원장 기록 여부는 해시로도 조회된다.
            "consentReceipt": {"hash": h, "txHash": None, "anchor": "pending" if anchoring else "skipped",
                               "object": receipt_obj},
            "bundle": {"bundle": self.s.bundle, "version": self.s.version, "bundleHash": self.bundle_hash},
        }

    def anchor_consent_receipt(self, h: str) -> str | None:
        """동의 영수증 해시를 원장에 앵커 (BackgroundTasks 에서 실행). 실패해도 발급은 유효하다."""
        if not self.ledger or not self.ledger.is_connected():
            return None
        try:
            tx = self.ledger.anchor_receipt(h, KIND_CONSENT)
        except Exception as e:  # noqa: BLE001 — 앵커 실패해도 발급은 유효
            log.warning("consent receipt anchor failed: %s", e)
            return None
        self.store.set_receipt_tx(h, tx)
        return tx

    def consent_receipt(self, h: str) -> dict | None:
        r = self.store.get_receipt(h)
        if not r or r["kind"] != KIND_CONSENT:
            return None
        return {"hash": r["hash"], "txHash": r["tx_hash"], "anchor": "anchored" if r["tx_hash"] else "pending"}

    # ---------- 폐기 ----------
    def revoke(self, jti: str) -> dict:
        """폐기. 원장 게시에 실패하면 LedgerPublishError — 로컬은 폐기 상태로 남고 다음 게시 때 합쳐 올린다 (F07)."""
        cred = self.store.get_credential(jti)
        if not cred:
            raise LookupError("CREDENTIAL_UNKNOWN")
        with self._status_lock:
            self.store.mark_revoked(jti)
            version, tx = self._revoke_indices_locked([int(cred["status_index"])])
        return {"jti": jti, "statusListIndex": int(cred["status_index"]), "revoked": True,
                "statusListVersion": version, "txHash": tx}

    def revoke_by_bundle(self, bundle: str, version: str) -> dict:
        """규칙 번들 bundle@version 으로 발급한 VC 를 한 번에 폐기한다 — 규칙 오류 발견 시 일괄 폐기 (F43). 원장 게시는 1회."""
        with self._status_lock:
            creds = [c for c in self.store.credentials_by_bundle(bundle, version) if not c["revoked"]]
            for c in creds:
                self.store.mark_revoked(c["jti"])
            if creds:
                list_version, tx = self._revoke_indices_locked([int(c["status_index"]) for c in creds])
            else:
                list_version, tx = self.store.get_status_list(self.s.status_list_id)[1], None
        return {"bundle": bundle, "version": version, "revoked": len(creds),
                "statusListVersion": list_version, "txHash": tx}

    def is_revoked_locally(self, index: int) -> bool:
        bits, _ = self.store.get_status_list(self.s.status_list_id)
        return get_status(bytearray(bits), index)

    def reset_demo(self) -> dict:
        """발급 목록만 비운다. 상태목록 비트는 로컬·원장 모두 그대로 둔다 — 폐기된 VC 가 되살아나지 않는다 (F10).
        서 있는 비트의 인덱스는 _alloc_index 가 다시 배정하지 않는다."""
        with self._status_lock:
            self.store.clear_credentials()
            _, version = self.store.get_status_list(self.s.status_list_id)
        return {"reset": True, "statusListVersion": version, "txHash": None}

    def admin_credentials(self) -> dict:
        """관리 목록: 보유자 DID·상태 인덱스 없이 jti·claim·시각·폐기 여부와 claim 별 건수만 (F10)."""
        rows = self.store.list_credentials()
        items = [{"jti": r["jti"], "claim": r["claim"], "issued_at": r["issued_at"], "valid_until": r["valid_until"],
                  "revoked": bool(r["revoked"])} for r in rows]
        by_claim: dict[str, int] = {}
        for r in rows:
            by_claim[r["claim"]] = by_claim.get(r["claim"], 0) + 1
        info = {k: v for k, v in self.status_list_info().items() if k != "encoded"}
        info["pendingPublish"] = self.store.status_list_dirty(self.s.status_list_id)
        return {"issuer": {"did": self.s.did, "name": self.s.name}, "credentials": items, "byClaim": by_claim,
                "statusList": info}

    def well_known(self) -> dict:
        return {
            "did": self.s.did, "name": self.s.name, "kid": self.s.kid,
            "ed25519PublicKeyHex": self.key.public_key.hex(),
            "claims": [{"claim": c, "label": self.labels[c]} for c in self.my_claims],
            # evalDate: 발급기관이 판정에 쓰는 기준일(RULE_EVAL_DATE). 지갑 사전 판정이 같은 날짜를 쓰도록 공개한다 (F65)
            "bundle": {"bundle": self.s.bundle, "version": self.s.version, "bundleHash": self.bundle_hash,
                       "schemaHash": self.schema_hash, "evalDate": eval_date_from_env(self.bundle).isoformat()},
            "statusListId": self.s.status_list_id,
            "ledgerConnected": bool(self.ledger and self.ledger.is_connected()),
        }
