"""공동원장 클라이언트.

체인에 올라가는 것: 발급기관 공개키·규칙 번들 해시·상태목록 비트열·솔트 포함 영수증 해시.
체인에 절대 올리지 않는 것: 이름·주민번호·소득·VC 원문. 이 모듈에는 그런 값을 받는 함수가 없다.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware


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
                 private_key: str | None = None, cache_ttl_s: int = 60):
        self.deployment = deployment or load_deployment()
        self.rpc_url = rpc_url or os.environ.get("RPC_URL") or self.deployment.rpc_url or "http://127.0.0.1:8545"
        self.w3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": 10}))
        # Besu QBFT 는 extraData 가 길어서 PoA 미들웨어가 필요. Hardhat 에서는 무해.
        self.w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        self.account = self.w3.eth.account.from_key(private_key) if private_key else None
        self._c = {name: self.w3.eth.contract(address=Web3.to_checksum_address(c["address"]), abi=c["abi"])
                   for name, c in self.deployment.contracts.items()}
        self._cache: dict[str, tuple[float, Any]] = {}
        self.cache_ttl_s = cache_ttl_s

    # ---------- helpers ----------
    def _cached(self, key: str, fn):
        now = time.monotonic()
        hit = self._cache.get(key)
        if hit and now - hit[0] < self.cache_ttl_s:
            return hit[1]
        val = fn()
        self._cache[key] = (now, val)
        return val

    def _send(self, fn) -> str:
        if not self.account:
            raise RuntimeError("no private key configured for writes")
        tx = fn.build_transaction({
            "from": self.account.address,
            "nonce": self.w3.eth.get_transaction_count(self.account.address, "pending"),
            "gasPrice": self.w3.eth.gas_price,
            "chainId": self.deployment.chain_id,
        })
        tx["gas"] = int(self.w3.eth.estimate_gas(tx) * 1.2)
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(h, timeout=60)
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
        def fetch():
            r = self._c["IssuerRegistry"].functions.get(did).call()
            return {"did": r[0], "ed25519PubKey": bytes(r[1]), "name": r[2], "controller": r[3],
                    "active": bool(r[4]), "registeredAt": int(r[5])}
        return self._cached(f"issuer:{did}", fetch)

    def issuer_exists(self, did: str) -> bool:
        return bool(self._c["IssuerRegistry"].functions.exists(did).call())

    def register_issuer(self, did: str, ed25519_pubkey: bytes, name: str, controller: str) -> str:
        assert len(ed25519_pubkey) == 32
        return self._send(self._c["IssuerRegistry"].functions.register(did, ed25519_pubkey, name,
                                                                        Web3.to_checksum_address(controller)))

    def set_issuer_active(self, did: str, active: bool) -> str:
        self._cache.pop(f"issuer:{did}", None)
        return self._send(self._c["IssuerRegistry"].functions.setActive(did, active))

    # ---------- RuleRegistry ----------
    def get_bundle(self, bundle: str, version: str) -> dict:
        def fetch():
            r = self._c["RuleRegistry"].functions.getBundle(bundle, version).call()
            return {"bundleHash": "0x" + bytes(r[0]).hex(), "schemaHash": "0x" + bytes(r[1]).hex(),
                    "by": r[2], "at": int(r[3])}
        return self._cached(f"bundle:{bundle}:{version}", fetch)

    def has_bundle(self, bundle: str, version: str) -> bool:
        return bool(self._c["RuleRegistry"].functions.hasBundle(bundle, version).call())

    def register_bundle(self, bundle: str, version: str, bundle_hash: str, schema_hash: str) -> str:
        return self._send(self._c["RuleRegistry"].functions.registerBundle(
            bundle, version, bytes.fromhex(bundle_hash.removeprefix("0x")), bytes.fromhex(schema_hash.removeprefix("0x"))))

    # ---------- StatusListRegistry ----------
    def get_status_list(self, list_id: str) -> dict:
        # 폐기 상태는 캐시하지 않는다 — 폐기 직후 즉시 차단되어야 한다.
        r = self._c["StatusListRegistry"].functions.get(list_id).call()
        return {"encodedList": bytes(r[0]).decode("ascii"), "version": int(r[1]), "updatedAt": int(r[2]), "owner": r[3]}

    def publish_status_list(self, list_id: str, encoded_list: str, version: int) -> str:
        return self._send(self._c["StatusListRegistry"].functions.publish(list_id, encoded_list.encode("ascii"), version))

    # ---------- ReceiptAnchor ----------
    def anchor_receipt(self, salted_hash: str, kind: int) -> str:
        return self._send(self._c["ReceiptAnchor"].functions.anchor(bytes.fromhex(salted_hash.removeprefix("0x")), kind))

    def anchored_at(self, salted_hash: str) -> int:
        return int(self._c["ReceiptAnchor"].functions.anchoredAt(bytes.fromhex(salted_hash.removeprefix("0x"))).call())

    def block_number(self) -> int:
        return int(self.w3.eth.block_number)
