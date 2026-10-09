"""dbp_rules — 대구 혜택패스 규칙 엔진.

- jsonlogic: JSON Logic 부분집합 평가기 (불리언 전용, 정수 연산만)
- bundle: 규칙 번들 로드·조합·해시
- engine: 전처리 → claim 판정 → 정책 판정, 범주값 프로필 파생
- reference: JSON Logic을 쓰지 않는 참조 구현 (테스트 기댓값 생성용)
"""
from .bundle import bundle_hash, load_bundle
from .canonical import canonicalize, sha256_hex
from .engine import (
    categorical_profile,
    evaluate_claims,
    evaluate_policies,
    evaluate_policy_partial,
    preprocess,
    rule_vars,
)
from .jsonlogic import evaluate
from .paths import repo_root
from .policies import claim_sets, load_policies

__all__ = [
    "bundle_hash", "load_bundle", "canonicalize", "sha256_hex", "categorical_profile",
    "evaluate_claims", "evaluate_policies", "evaluate_policy_partial", "preprocess", "rule_vars", "evaluate",
    "repo_root", "load_policies", "claim_sets",
]
