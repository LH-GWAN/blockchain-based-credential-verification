from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field

ISSUER_NAMES = {"daegu": "대구광역시", "welfare": "사회보장정보원(복지기관)"}
# 발급기관별로 아는 원본 필드 (실서비스: 대구시=주민등록·가구, 복지기관=사회보장정보시스템의 소득인정액·수급·소득자료)
# 은행은 발급기관이 아니다 — 검증기관일 뿐이며 신용평점은 창구가 자체 조회한다.
ISSUER_KNOWN_FIELDS = {
    "daegu": ["citizenId", "birthDate", "residence", "householdSize", "hasStudentChild"],
    "welfare": ["citizenId", "householdSize", "monthlyIncomeKRW", "isBasicLivelihoodRecipient", "annualIncomeKRW"],
}
DEFAULT_EVM_KEYS = {
    "daegu": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",   # hardhat #1
    "welfare": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",  # hardhat #2
}


def deterministic_seed(issuer_id: str) -> bytes:
    """데모용 결정론적 Ed25519 시드. 실서비스에서는 HSM/KMS 로 교체."""
    return hashlib.sha256(f"dbp-issuer-ed25519-{issuer_id}".encode()).digest()


@dataclass
class Settings:
    issuer_id: str = field(default_factory=lambda: os.environ.get("ISSUER_ID", "daegu"))
    port: int = field(default_factory=lambda: int(os.environ.get("ISSUER_PORT", "8001")))
    db_path: str = field(default_factory=lambda: os.environ.get("ISSUER_DB_PATH", ""))
    evm_private_key: str = field(default_factory=lambda: os.environ.get("ISSUER_EVM_PRIVATE_KEY", ""))
    ed25519_seed_hex: str = field(default_factory=lambda: os.environ.get("ISSUER_ED25519_SEED", ""))
    rpc_url: str = field(default_factory=lambda: os.environ.get("RPC_URL", "http://127.0.0.1:8545"))
    ledger_optional: bool = field(default_factory=lambda: os.environ.get("LEDGER_OPTIONAL", "0") == "1")
    bundle: str = "daegu-eligibility"
    version: str = "2026.1"
    vc_valid_days: int = 365

    def __post_init__(self) -> None:
        if self.issuer_id not in ISSUER_NAMES:
            raise ValueError(f"unknown ISSUER_ID {self.issuer_id}")
        if not self.db_path:
            self.db_path = f"./issuer-{self.issuer_id}.db"
        if not self.evm_private_key:
            self.evm_private_key = DEFAULT_EVM_KEYS[self.issuer_id]

    @property
    def did(self) -> str:
        return f"did:dbp:{self.issuer_id}"

    @property
    def kid(self) -> str:
        return f"{self.did}#key-1"

    @property
    def name(self) -> str:
        return ISSUER_NAMES[self.issuer_id]

    @property
    def status_list_id(self) -> str:
        return f"dbp:status:{self.issuer_id}:list-1"

    @property
    def ed25519_seed(self) -> bytes:
        if self.ed25519_seed_hex:
            return bytes.fromhex(self.ed25519_seed_hex.removeprefix("0x"))
        return deterministic_seed(self.issuer_id)

    @property
    def known_fields(self) -> list[str]:
        return ISSUER_KNOWN_FIELDS[self.issuer_id]
