"""dbp_vc — VC/VP 생성·서명·검증, did:key, JCS 해시, Bitstring Status List, 영수증 해시.

TS `@dbp/vc` 와 동작이 동일하다. 함수명은 snake_case, 반환/입력 dict의 키는 VC JSON과 같은 camelCase
(예: verify_vc()["checks"]["notExpired"], status={"listId":..., "index":...}).
"""

from .didkey import HolderKey, did_key_to_public_key, generate_holder_key, public_key_to_did_key
from .ed25519 import (
    ed25519_is_valid_public_key,
    ed25519_public_key,
    ed25519_public_key_hex,
    ed25519_sign,
    ed25519_verify,
)
from .errors import VcError
from .jcs import bundle_hash, canonicalize, sha256_hex
from .jws import DecodedJws, b64url_decode, b64url_encode, decode_jws, sign_jws, verify_jws
from .receipt import random_nonce, random_salt, receipt_hash
from .statuslist import (
    DEFAULT_STATUS_LIST_SIZE,
    create_status_list,
    decode_status_list,
    encode_status_list,
    get_status,
    set_status,
)
from .timeutil import iso_to_seconds, to_seconds
from .vc import VC_CONTEXT, VC_JWT_TYP, VC_SCHEMA, VC_TYPE, decode_vc, issue_vc, verify_vc
from .vp import VP_JWT_TYP, create_vp, verify_vp

__all__ = [
    "DEFAULT_STATUS_LIST_SIZE",
    "VC_CONTEXT",
    "VC_JWT_TYP",
    "VC_SCHEMA",
    "VC_TYPE",
    "VP_JWT_TYP",
    "DecodedJws",
    "HolderKey",
    "VcError",
    "b64url_decode",
    "b64url_encode",
    "bundle_hash",
    "canonicalize",
    "create_status_list",
    "create_vp",
    "decode_jws",
    "decode_status_list",
    "decode_vc",
    "did_key_to_public_key",
    "ed25519_is_valid_public_key",
    "ed25519_public_key",
    "ed25519_public_key_hex",
    "ed25519_sign",
    "ed25519_verify",
    "encode_status_list",
    "generate_holder_key",
    "get_status",
    "iso_to_seconds",
    "issue_vc",
    "public_key_to_did_key",
    "random_nonce",
    "random_salt",
    "receipt_hash",
    "set_status",
    "sha256_hex",
    "sign_jws",
    "to_seconds",
    "verify_jws",
    "verify_vc",
    "verify_vp",
]
