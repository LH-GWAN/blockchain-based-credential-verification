"""공동원장 시드: 발급기관 2곳 등록(거버넌스) → 규칙 번들 등록(대구시 컨트롤러) → 빈 상태목록 게시(각 발급기관).
멱등: 이미 등록된 항목은 건너뛴다.   실행: uv run python scripts/seed_ledger.py
"""
from __future__ import annotations

import json
import os
import sys

from dbp_ledger import LedgerClient
from dbp_rules import bundle_hash, load_bundle
from dbp_rules.bundle import schema_hash
from dbp_vc import create_status_list, encode_status_list, generate_holder_key

from dbp_issuer.config import DEFAULT_EVM_KEYS, ISSUER_NAMES, deterministic_seed

GOV_KEY = os.environ.get("GOVERNANCE_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
RPC = os.environ.get("RPC_URL", "http://127.0.0.1:8545")


def main() -> int:
    gov = LedgerClient(rpc_url=RPC, private_key=GOV_KEY)
    if not gov.is_connected():
        print(f"원장에 연결할 수 없습니다: {RPC}", file=sys.stderr)
        return 1
    b = load_bundle()
    bh, sh = bundle_hash(b), schema_hash()
    summary: dict = {"rpc": RPC, "chainId": gov.deployment.chain_id, "bundleHash": bh, "issuers": {}, "txs": []}

    controllers: dict[str, LedgerClient] = {}
    for issuer_id, name in ISSUER_NAMES.items():
        did = f"did:dbp:{issuer_id}"
        key = generate_holder_key(os.environ.get(f"ISSUER_ED25519_SEED_{issuer_id.upper()}") and
                            bytes.fromhex(os.environ[f"ISSUER_ED25519_SEED_{issuer_id.upper()}"]) or deterministic_seed(issuer_id))
        ctl = LedgerClient(rpc_url=RPC, private_key=os.environ.get(f"ISSUER_EVM_PRIVATE_KEY_{issuer_id.upper()}", DEFAULT_EVM_KEYS[issuer_id]))
        controllers[issuer_id] = ctl
        if gov.issuer_exists(did):
            print(f"[skip] issuer {did} already registered")
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
            print(f"[skip] status list {list_id} exists (v{cur['version']})")
        except Exception:
            tx = ctl.publish_status_list(list_id, empty, 1)
            summary["txs"].append({"publishStatusList": list_id, "tx": tx})
            print(f"[ok] published empty status list {list_id} v1 tx={tx}")

    out = os.path.join("chain", "deployments", "seed-summary.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"summary → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
