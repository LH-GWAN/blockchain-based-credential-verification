"""공동원장 시드: 발급기관 2곳 등록(거버넌스) → 규칙 번들 등록(대구시 컨트롤러) → 빈 상태목록 게시(각 발급기관).
멱등: 이미 등록된 항목은 건너뛴다. 단, 이미 등록된 발급기관 공개키·컨트롤러나 상태목록 게시자가 로컬 키와 다르면
멈춘다(exit 2) — 그대로 두면 발급기관이 상태목록을 게시하지 못해(NOT_LIST_OWNER) 폐기가 원장에 반영되지 않는다.
키 환경변수(비우면 기본값): GOVERNANCE_PRIVATE_KEY, ISSUER_EVM_PRIVATE_KEY_<DAEGU|WELFARE>, ISSUER_ED25519_SEED_<DAEGU|WELFARE>
— 발급기관 인스턴스(dbp_issuer)는 접미사 없는 ISSUER_EVM_PRIVATE_KEY / ISSUER_ED25519_SEED 를 읽으므로 같은 값을 넣는다.
실행: uv run python scripts/seed_ledger.py
"""
from __future__ import annotations

import json
import os
import sys

from dbp_issuer.config import DEFAULT_EVM_KEYS, ISSUER_NAMES, deterministic_seed
from dbp_ledger import LedgerClient, LedgerUnavailable
from dbp_rules import bundle_hash, load_bundle
from dbp_rules.bundle import schema_hash
from dbp_vc import create_status_list, encode_status_list, generate_holder_key

DEFAULT_GOV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # hardhat #0


def env_or(name: str, default: str) -> str:
    """빈 값('NAME=')도 기본값으로 본다 — .env 를 그대로 export 한 경우."""
    return (os.environ.get(name) or "").strip() or default


def issuer_keys(issuer_id: str) -> tuple[bytes, str]:
    """(Ed25519 시드, EVM 컨트롤러 키). 발급기관 config 와 같은 기본값을 쓴다."""
    seed_hex = env_or(f"ISSUER_ED25519_SEED_{issuer_id.upper()}", "")
    seed = bytes.fromhex(seed_hex.removeprefix("0x")) if seed_hex else deterministic_seed(issuer_id)
    return seed, env_or(f"ISSUER_EVM_PRIVATE_KEY_{issuer_id.upper()}", DEFAULT_EVM_KEYS[issuer_id])


def registered_mismatch(on: dict, pubkey: bytes, controller: str) -> list[str]:
    """원장에 등록된 발급기관 레코드와 로컬 키를 비교해 다른 항목을 돌려준다."""
    diff = []
    if bytes(on.get("ed25519PubKey") or b"") != pubkey:
        diff.append(f"Ed25519 공개키 (원장 {bytes(on.get('ed25519PubKey') or b'').hex()[:16]}… ≠ 로컬 {pubkey.hex()[:16]}…)")
    if str(on.get("controller", "")).lower() != controller.lower():
        diff.append(f"컨트롤러 (원장 {on.get('controller')} ≠ 로컬 {controller})")
    return diff


def main() -> int:
    rpc = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
    gov = LedgerClient(rpc_url=rpc, private_key=env_or("GOVERNANCE_PRIVATE_KEY", DEFAULT_GOV_KEY))
    if not gov.is_connected():
        print(f"원장에 연결할 수 없습니다: {rpc}", file=sys.stderr)
        return 1
    b = load_bundle()
    bh, sh = bundle_hash(b), schema_hash()
    summary: dict = {"rpc": rpc, "chainId": gov.deployment.chain_id, "bundleHash": bh, "issuers": {}, "txs": []}
    problems: list[str] = []

    controllers: dict[str, LedgerClient] = {}
    for issuer_id, name in ISSUER_NAMES.items():
        did = f"did:dbp:{issuer_id}"
        seed, evm_key = issuer_keys(issuer_id)
        key = generate_holder_key(seed)
        ctl = LedgerClient(rpc_url=rpc, private_key=evm_key)
        controllers[issuer_id] = ctl
        if gov.issuer_exists(did):
            diff = registered_mismatch(gov.get_issuer(did), key.public_key, ctl.account.address)
            if diff:
                problems += [f"{did}: {d}" for d in diff]
                print(f"[MISMATCH] issuer {did} already registered with different " + ", ".join(diff), file=sys.stderr)
            else:
                print(f"[skip] issuer {did} already registered (키·컨트롤러 일치)")
        else:
            tx = gov.register_issuer(did, key.public_key, name, ctl.account.address)
            summary["txs"].append({"registerIssuer": did, "tx": tx})
            print(f"[ok] registered {did} ({name}) pubkey={key.public_key.hex()[:16]}… controller={ctl.account.address} tx={tx}")
        summary["issuers"][did] = {"name": name, "controller": ctl.account.address, "ed25519PublicKeyHex": key.public_key.hex()}

    daegu = controllers["daegu"]
    if daegu.has_bundle(b["bundle"], b["version"]):
        on = daegu.get_bundle(b["bundle"], b["version"])
        status = "match" if on["bundleHash"].lower() == bh.lower() else "MISMATCH"
        print(f"[skip] bundle {b['bundle']}@{b['version']} already registered ({status}: {on['bundleHash']})")
        if status != "match":
            print("!! 원장의 번들 해시가 로컬과 다릅니다. 규칙을 바꿨다면 version 을 올려야 합니다.", file=sys.stderr)
            return 2
    else:
        tx = daegu.register_bundle(b["bundle"], b["version"], bh, sh)
        summary["txs"].append({"registerBundle": f"{b['bundle']}@{b['version']}", "tx": tx})
        print(f"[ok] registered bundle {b['bundle']}@{b['version']} hash={bh} tx={tx}")

    empty = encode_status_list(create_status_list(131072))
    for issuer_id, ctl in controllers.items():
        list_id = f"dbp:status:{issuer_id}:list-1"
        try:
            cur = ctl.get_status_list(list_id)
        except LedgerUnavailable:
            raise
        except Exception:  # noqa: BLE001 — 미게시 목록 → 컨트랙트 revert
            cur = None
        if cur is None:
            tx = ctl.publish_status_list(list_id, empty, 1)
            summary["txs"].append({"publishStatusList": list_id, "tx": tx})
            print(f"[ok] published empty status list {list_id} v1 tx={tx}")
        elif cur.get("owner") and str(cur["owner"]).lower() != ctl.account.address.lower():
            problems.append(f"{list_id}: 게시자 (원장 {cur['owner']} ≠ 로컬 컨트롤러 {ctl.account.address})")
            print(f"[MISMATCH] status list {list_id} owner {cur['owner']} ≠ {ctl.account.address}", file=sys.stderr)
        else:
            print(f"[skip] status list {list_id} exists (v{cur['version']})")

    out = os.path.join("chain", "deployments", "seed-summary.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"summary → {out}")
    if problems:
        print("!! 원장에 이미 등록된 키가 로컬 설정과 다릅니다 — 발급기관의 상태목록 게시(폐기)가 실패합니다:", file=sys.stderr)
        for p in problems:
            print("   - " + p, file=sys.stderr)
        print("   ISSUER_EVM_PRIVATE_KEY_* / ISSUER_ED25519_SEED_* 를 원장 등록값에 맞추거나, 컨트랙트를 새로 배포하세요.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
