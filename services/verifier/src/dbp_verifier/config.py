from __future__ import annotations

import os
from dataclasses import dataclass, field

VERIFIERS = {
    "imbank-branch-01": {"did": "did:dbp:verifier-imbank-branch-01", "name": "iM뱅크 칠성동지점", "kind": "bank"},
    "bukgu-welfare-01": {"did": "did:dbp:verifier-bukgu-welfare-01", "name": "대구 북구 행정복지센터", "kind": "welfare"},
}
REASON_KO = {
    "AUD_MISMATCH": "다른 기관에 제출된 증명입니다",
    "NONCE_MISSING": "1회용 확인번호가 없습니다",
    "NONCE_UNKNOWN": "알 수 없는 검증 요청입니다",
    "NONCE_EXPIRED": "검증 요청 시간이 만료되었습니다",
    "NONCE_REUSED": "이미 사용된 제출입니다 (재사용 차단)",
    "VP_SIG_INVALID": "제출 서명이 올바르지 않습니다",
    "ISSUER_UNKNOWN": "원장에 등록되지 않은 발급기관입니다",
    "ISSUER_INACTIVE": "정지된 발급기관입니다",
    "VC_SIG_INVALID": "증명서 서명이 위조·변조되었습니다",
    "EXPIRED": "증명서 유효기간이 지났습니다",
    "NOT_YET_VALID": "아직 유효하지 않은 증명서입니다",
    "HOLDER_MISMATCH": "제출자가 증명서의 소유자가 아닙니다",
    "REVOKED": "폐기된 증명서입니다",
    "RULE_HASH_MISMATCH": "판정에 사용된 규칙 버전이 원장과 다릅니다",
    "STATUS_LIST_UNAVAILABLE": "원장에서 상태 목록을 찾을 수 없습니다",
    "CLAIM_MISSING": "요청한 항목의 증명서가 없습니다",
    "CLAIM_FALSE": "요청한 항목이 충족되지 않았습니다",
    "VP_MALFORMED": "제출 형식이 올바르지 않습니다",
}


@dataclass
class Settings:
    port: int = field(default_factory=lambda: int(os.environ.get("VERIFIER_PORT", "8002")))
    default_verifier: str = field(default_factory=lambda: os.environ.get("VERIFIER_ID", "imbank-branch-01"))
    evm_private_key: str = field(default_factory=lambda: os.environ.get(
        "VERIFIER_EVM_PRIVATE_KEY", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"))  # hardhat #3
    rpc_url: str = field(default_factory=lambda: os.environ.get("RPC_URL", "http://127.0.0.1:8545"))
    request_ttl_s: int = 120
    public_response_uri: str = field(default_factory=lambda: os.environ.get("VERIFIER_PUBLIC_URL", "http://localhost:8002") + "/present")
