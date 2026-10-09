from __future__ import annotations

import os
from dataclasses import dataclass, field

# 검증기관은 금융 창구뿐이다 (은행·저축은행). 공공기관 사이의 확인은 행정정보 공동이용이 이미 담당한다.
VERIFIERS = {
    "imbank-branch-01": {"did": "did:dbp:verifier-imbank-branch-01", "name": "iM뱅크 칠성동지점", "kind": "bank"},
    "im-savings-01": {"did": "did:dbp:verifier-im-savings-01", "name": "iM저축은행 대구지점 (모사)", "kind": "savings"},
}
# 창구 용도 프리셋: 어떤 참/거짓 항목만 받으면 되는지 (소득금액증명 원본 대신)
# verifierKinds: 그 상품을 실제로 취급하는 창구 종류. 새희망홀씨는 은행권 상품이라 저축은행에는 없다.
# counterChecked: 증명서로 받지 않고 창구가 먼저 자체 조회한 항목(신용평점). 정책 판정 재현에 창구 확인값으로 들어간다.
PRESETS = [
    {"id": "consult", "label": "서민금융 상담 대상 확인", "purpose": "서민금융 상담 대상 확인",
     "requested": [{"claim": "daeguResident", "expected": True}, {"claim": "incomeBelow50Median", "expected": True}],
     "policyId": None, "verifierKinds": ["bank", "savings"],
     "hint": "대구 거주 여부와 기준 중위소득 50% 이하 여부, 두 항목의 참/거짓만 받습니다."},
    {"id": "sunshine-general", "label": "햇살론 일반보증 대상 확인", "purpose": "햇살론 일반보증 대상 확인",
     "requested": [{"claim": "annualIncomeUnder35M", "expected": True}], "policyId": "sunshine-loan-general",
     "verifierKinds": ["bank", "savings"],
     "hint": "소득금액증명 원본 대신 '연소득 3,500만 원 이하 = 참' 1개 항목만 받습니다. 신용평점·재직(사업) 기간·보증 심사용 소득 증빙은 창구가 자체 확인합니다. 2026년 개편으로 은행·저축은행 모두 취급합니다."},
    {"id": "sunshine-general-low-credit", "label": "햇살론 일반보증 · 신용 하위 20% 고객",
     "purpose": "햇살론 일반보증 대상 확인 (신용평점 하위 20%)",
     "requested": [{"claim": "annualIncomeUnder45M", "expected": True}], "policyId": "sunshine-loan-general",
     "verifierKinds": ["bank", "savings"], "counterChecked": [{"claim": "creditBottom20", "expected": True}],
     "hint": "창구 조회로 신용평점 하위 20%인 고객: 소득금액증명 원본 대신 '연소득 4,500만 원 이하 = 참' 1개 항목만 받습니다. 재직(사업) 기간·보증 심사용 소득 증빙은 창구가 자체 확인합니다."},
    {"id": "new-hope", "label": "새희망홀씨 대상 확인", "purpose": "새희망홀씨 대상 확인",
     "requested": [{"claim": "annualIncomeUnder40M", "expected": True}], "policyId": "new-hope-loan",
     "verifierKinds": ["bank"],
     "hint": "소득금액증명 원본 대신 '연소득 4,000만 원 이하 = 참' 1개 항목만 받습니다. 신용평점·재직 등 대출 심사는 은행이 자체 확인합니다. 은행권 상품이라 저축은행 창구에는 없습니다."},
    {"id": "new-hope-low-credit", "label": "새희망홀씨 · 신용 하위 20% 고객",
     "purpose": "새희망홀씨 대상 확인 (신용평점 하위 20%)",
     "requested": [{"claim": "annualIncomeUnder50M", "expected": True}], "policyId": "new-hope-loan",
     "verifierKinds": ["bank"], "counterChecked": [{"claim": "creditBottom20", "expected": True}],
     "hint": "은행 조회로 신용평점 하위 20%인 고객: 소득금액증명 원본 대신 '연소득 5,000만 원 이하 = 참' 1개 항목만 받습니다. 재직 등 대출 심사는 은행이 자체 확인합니다."},
    {"id": "discount", "label": "공공요금 감면 대상 확인", "purpose": "공공요금 감면 대상 확인",
     "requested": [{"claim": "incomeBelow50Median", "expected": True}], "policyId": None, "verifierKinds": ["bank", "savings"],
     "hint": "전기·도시가스·통신 요금 감면 창구가 수급자증명서 원본 대신 '기준 중위소득 50% 이하 = 참' 1개 항목만 받습니다."},
]
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
    "PRESET_NOT_OFFERED": "이 창구에서 취급하지 않는 상품입니다",
    "POLICY_UNKNOWN": "규칙 묶음에 없는 정책입니다",
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
