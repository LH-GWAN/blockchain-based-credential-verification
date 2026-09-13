"""원장 접근 인터페이스. 테스트에서는 FakeLedger 로 대체."""
from __future__ import annotations

from typing import Protocol


class Ledger(Protocol):
    def is_connected(self) -> bool: ...
    def get_bundle(self, bundle: str, version: str) -> dict: ...
    def get_status_list(self, list_id: str) -> dict: ...
    def publish_status_list(self, list_id: str, encoded_list: str, version: int) -> str: ...
    def anchor_receipt(self, salted_hash: str, kind: int) -> str: ...


class FakeLedger:
    """메모리 원장 (단위 테스트·오프라인 데모용)."""

    def __init__(self, bundle_hash: str, bundle: str = "daegu-eligibility", version: str = "2026.1"):
        self.bundles = {(bundle, version): {"bundleHash": bundle_hash, "schemaHash": "0x" + "00" * 32, "by": "0x0", "at": 0}}
        self.status_lists: dict[str, dict] = {}
        self.receipts: dict[str, int] = {}
        self._n = 0

    def _tx(self) -> str:
        self._n += 1
        return "0xfake" + f"{self._n:060x}"

    def is_connected(self) -> bool:
        return True

    def get_bundle(self, bundle: str, version: str) -> dict:
        return self.bundles[(bundle, version)]

    def get_status_list(self, list_id: str) -> dict:
        if list_id not in self.status_lists:
            raise KeyError(list_id)
        return self.status_lists[list_id]

    def publish_status_list(self, list_id: str, encoded_list: str, version: int) -> str:
        cur = self.status_lists.get(list_id)
        if cur and version <= cur["version"]:
            raise RuntimeError("version must increase")
        self.status_lists[list_id] = {"encodedList": encoded_list, "version": version, "updatedAt": 0, "owner": "0x0"}
        return self._tx()

    def anchor_receipt(self, salted_hash: str, kind: int) -> str:
        if salted_hash in self.receipts:
            raise RuntimeError("duplicate receipt")
        self.receipts[salted_hash] = kind
        return self._tx()
