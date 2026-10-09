"""공동원장 클라이언트.

체인에 올라가는 것: 발급기관 공개키·규칙 번들 해시·상태목록 비트열·솔트 포함 영수증 해시.
체인에 절대 올리지 않는 것: 이름·주민번호·소득·VC 원문. 이 모듈에는 그런 값을 받는 함수가 없다.

오류 구분 (검증기관이 사유 코드를 고르는 기준):
- 컨트랙트 revert(미등록 발급기관·미게시 목록 등) → web3 의 ContractLogicError 그대로("없음"으로 취급)
- RPC 전송 오류·시간 초과·노드 오류 → LedgerUnavailable (원장 장애, "없음"과 다르다)
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

import requests
from web3 import Web3
from web3.exceptions import ContractLogicError, ProviderConnectionError, TimeExhausted, Web3RPCError
from web3.middleware import ExtraDataToPOAMiddleware

T = TypeVar("T")

# 읽기 RPC 1건의 HTTP 타임아웃(초). web3 기본 재시도(5회)는 끈다 — 멈춘 원장에서 조회 하나가 약 52초 걸리던 문제(F34).
DEFAULT_TIMEOUT_S = 3.0
# 발급기관 레코드 캐시 상한(초). 정지·키 교체가 이 시간 안에 검증기관에 반영된다(F59).
ISSUER_CACHE_TTL_S = 5.0
# 규칙 번들은 (번들, 버전)당 1회 등록되고 바뀌지 않으므로 더 길게 캐시한다.
BUNDLE_CACHE_TTL_S = 60.0
# 상태목록 캐시 상한(초). 0 = 캐시하지 않음(폐기 직후 즉시 차단). 2초를 넘길 수 없다.
STATUS_LIST_CACHE_TTL_S = 0.0
STATUS_LIST_CACHE_TTL_MAX_S = 2.0


class LedgerUnavailable(RuntimeError):
    """원장 RPC 에 닿지 못했거나 시간 안에 응답이 없다(전송 오류·타임아웃·노드 오류).
    컨트랙트 revert("등록되지 않음")와 구분하기 위한 예외다."""


# 전송 계층 오류 — requests(HTTPProvider 내부)·소켓·web3 연결 오류
_TRANSPORT_ERRORS: tuple[type[BaseException], ...] = (
    requests.exceptions.RequestException, OSError, ProviderConnectionError, TimeExhausted,
)


def _guard(fn: Callable[[], T]) -> T:
    """원장 호출을 감싸 전송 오류만 LedgerUnavailable 로 바꾼다. revert 는 그대로 올린다."""
    try:
        return fn()
    except ContractLogicError:
        raise
    except LedgerUnavailable:
        raise
    except _TRANSPORT_ERRORS as e:
        raise LedgerUnavailable(f"ledger unreachable: {type(e).__name__}") from e
    except Web3RPCError as e:  # revert 가 아닌 노드 측 RPC 오류
        raise LedgerUnavailable(f"ledger rpc error: {e}") from e


# 같은 RPC·같은 계정으로 보내는 tx 는 프로세스 안에서 하나씩 nonce 를 받는다(F61).
_SEND_LOCKS: dict[str, threading.Lock] = {}
_SEND_LOCKS_GUARD = threading.Lock()


def _send_lock(rpc_url: str, address: str) -> threading.Lock:
    key = f"{rpc_url}|{address.lower()}"
    with _SEND_LOCKS_GUARD:
        lock = _SEND_LOCKS.get(key)
        if lock is None:
            lock = _SEND_LOCKS[key] = threading.Lock()
        return lock


@dataclass
class Deployment:
    chain_id: int
    rpc_url: str
    contracts: dict[str, dict[str, Any]]  # name -> {address, abi}


def _find_repo_root() -> Path:
    env = os.environ.get("DBP_REPO_ROOT")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for p in [here, *here.parents]:
        if (p / "pnpm-workspace.yaml").exists():
            return p
    raise RuntimeError("repo root not found")


def load_deployment(path: str | Path | None = None) -> Deployment:
    p = Path(path or os.environ.get("DEPLOYMENT_FILE") or _find_repo_root() / "chain/deployments/latest.json")
    d = json.loads(p.read_text(encoding="utf-8"))
    return Deployment(chain_id=int(d["chainId"]), rpc_url=d.get("rpcUrl", ""), contracts=d["contracts"])


class LedgerClient:
    """읽기는 누구나, 쓰기는 private_key 가 있을 때만."""

    def __init__(self, rpc_url: str | None = None, deployment: Deployment | None = None,
                 private_key: str | None = None, timeout_s: float = DEFAULT_TIMEOUT_S,
                 issuer_cache_ttl_s: float = ISSUER_CACHE_TTL_S,
                 status_list_cache_ttl_s: float = STATUS_LIST_CACHE_TTL_S):
        self.deployment = deployment or load_deployment()
        self.rpc_url = rpc_url or os.environ.get("RPC_URL") or self.deployment.rpc_url or "http://127.0.0.1:8545"
        self.timeout_s = timeout_s
        self.w3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": timeout_s},
                                         exception_retry_configuration=None))
        # Besu QBFT 는 extraData 가 길어서 PoA 미들웨어가 필요. Hardhat 에서는 무해.
        self.w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        self.account = self.w3.eth.account.from_key(private_key) if private_key else None
        self._c = {name: self.w3.eth.contract(address=Web3.to_checksum_address(c["address"]), abi=c["abi"])
                   for name, c in self.deployment.contracts.items()}
        self._cache: dict[str, tuple[float, Any]] = {}
        self.issuer_cache_ttl_s = min(issuer_cache_ttl_s, ISSUER_CACHE_TTL_S)
        self.status_list_cache_ttl_s = min(status_list_cache_ttl_s, STATUS_LIST_CACHE_TTL_MAX_S)

    # ---------- helpers ----------
    def _cached(self, key: str, ttl_s: float, fn: Callable[[], T]) -> T:
        """성공한 조회만 캐시한다. revert·LedgerUnavailable 은 캐시하지 않는다."""
        if ttl_s <= 0:
            return _guard(fn)
        now = time.monotonic()
        hit = self._cache.get(key)
        if hit and now - hit[0] < ttl_s:
            return hit[1]
        val = _guard(fn)
        self._cache[key] = (now, val)
        return val

    def _send(self, fn) -> str:
        if not self.account:
            raise RuntimeError("no private key configured for writes")
        # nonce 조회 → 서명 → 전송까지를 계정별 락으로 직렬화한다. 동시 요청이 같은 pending nonce 를
        # 받아 'nonce too low' 로 실패하던 문제(F61). 전송 직후 노드의 pending nonce 가 올라가므로
        # 영수증 대기는 락 밖에서 한다.
        with _send_lock(self.rpc_url, self.account.address):
            def build_and_send():
                tx = fn.build_transaction({
                    "from": self.account.address,
                    "nonce": self.w3.eth.get_transaction_count(self.account.address, "pending"),
                    "gasPrice": self.w3.eth.gas_price,
                    "chainId": self.deployment.chain_id,
                })
                tx["gas"] = int(self.w3.eth.estimate_gas(tx) * 1.2)
                signed = self.account.sign_transaction(tx)
                return self.w3.eth.send_raw_transaction(signed.raw_transaction)
            h = _guard(build_and_send)
        receipt = _guard(lambda: self.w3.eth.wait_for_transaction_receipt(h, timeout=60))
        if receipt["status"] != 1:
            raise RuntimeError(f"tx failed: {h.hex()}")
        return "0x" + h.hex().removeprefix("0x")

    def is_connected(self) -> bool:
        try:
            return self.w3.is_connected()
        except Exception:
            return False

    # ---------- IssuerRegistry ----------
    def get_issuer(self, did: str) -> dict:
        """미등록이면 ContractLogicError(ISSUER_UNKNOWN), 원장 장애면 LedgerUnavailable.
        controller = 이 기관이 원장에 tx 를 보내는 EVM 주소(상태목록 owner 와 대조용)."""
        def fetch():
            r = self._c["IssuerRegistry"].functions.get(did).call()
            return {"did": r[0], "ed25519PubKey": bytes(r[1]), "name": r[2], "controller": r[3],
                    "active": bool(r[4]), "registeredAt": int(r[5])}
        return self._cached(f"issuer:{did}", self.issuer_cache_ttl_s, fetch)

    def issuer_exists(self, did: str) -> bool:
        return bool(_guard(lambda: self._c["IssuerRegistry"].functions.exists(did).call()))

    def register_issuer(self, did: str, ed25519_pubkey: bytes, name: str, controller: str) -> str:
        assert len(ed25519_pubkey) == 32
        return self._send(self._c["IssuerRegistry"].functions.register(did, ed25519_pubkey, name,
                                                                        Web3.to_checksum_address(controller)))

    def set_issuer_active(self, did: str, active: bool) -> str:
        self._cache.pop(f"issuer:{did}", None)
        try:
            return self._send(self._c["IssuerRegistry"].functions.setActive(did, active))
        finally:
            self._cache.pop(f"issuer:{did}", None)

    # ---------- RuleRegistry ----------
    def get_bundle(self, bundle: str, version: str) -> dict:
        def fetch():
            r = self._c["RuleRegistry"].functions.getBundle(bundle, version).call()
            return {"bundleHash": "0x" + bytes(r[0]).hex(), "schemaHash": "0x" + bytes(r[1]).hex(),
                    "by": r[2], "at": int(r[3])}
        return self._cached(f"bundle:{bundle}:{version}", BUNDLE_CACHE_TTL_S, fetch)

    def has_bundle(self, bundle: str, version: str) -> bool:
        return bool(_guard(lambda: self._c["RuleRegistry"].functions.hasBundle(bundle, version).call()))

    def register_bundle(self, bundle: str, version: str, bundle_hash: str, schema_hash: str) -> str:
        return self._send(self._c["RuleRegistry"].functions.registerBundle(
            bundle, version, bytes.fromhex(bundle_hash.removeprefix("0x")), bytes.fromhex(schema_hash.removeprefix("0x"))))

    # ---------- StatusListRegistry ----------
    def get_status_list(self, list_id: str) -> dict:
        """폐기 상태는 기본적으로 캐시하지 않는다(최대 2초) — 폐기 직후 즉시 차단되어야 한다.
        owner = 이 목록을 게시한 EVM 주소(발급기관 controller 와 같아야 한다)."""
        def fetch():
            r = self._c["StatusListRegistry"].functions.get(list_id).call()
            return {"encodedList": bytes(r[0]).decode("ascii"), "version": int(r[1]), "updatedAt": int(r[2]),
                    "owner": r[3]}
        return self._cached(f"status:{list_id}", self.status_list_cache_ttl_s, fetch)

    def publish_status_list(self, list_id: str, encoded_list: str, version: int) -> str:
        try:
            return self._send(self._c["StatusListRegistry"].functions.publish(list_id, encoded_list.encode("ascii"), version))
        finally:
            self._cache.pop(f"status:{list_id}", None)

    # ---------- ReceiptAnchor ----------
    def anchor_receipt(self, salted_hash: str, kind: int) -> str:
        return self._send(self._c["ReceiptAnchor"].functions.anchor(bytes.fromhex(salted_hash.removeprefix("0x")), kind))

    def anchored_at(self, salted_hash: str) -> int:
        return int(_guard(lambda: self._c["ReceiptAnchor"].functions.anchoredAt(
            bytes.fromhex(salted_hash.removeprefix("0x"))).call()))

    def block_number(self) -> int:
        return int(_guard(lambda: self.w3.eth.block_number))
