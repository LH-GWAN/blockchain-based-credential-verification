"""조회형(pull) 대비 보유형(hold) 비교 데이터 — data/comparison.json 을 읽어 요청 항목별로 계산한다.

숫자와 항목을 화면에 하드코딩하지 않기 위한 단일 출처. scripts/pii_items.py 가 같은 함수를 써서 파일을 생성하고,
검증 서비스는 검증 결과마다 이 함수로 비교 블록을 붙인다. 외부 API 는 호출하지 않는다.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from dbp_rules import repo_root

HONESTY = "※ 조회형 열은 공공 마이데이터 서비스 문서에 기재된 전달 항목으로 구성한 비교이며, 실제 API 호출 결과가 아니다."


@lru_cache(maxsize=1)
def legacy() -> dict:
    p = repo_root() / "data/legacy-documents.json"
    return json.loads(p.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def precomputed() -> dict:
    p = repo_root() / "data/comparison.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"presets": {}}


def build_comparison(requested: list[dict], labels: dict[str, str], preset_id: str | None = None) -> dict:
    leg = legacy()
    doc_ids: list[str] = []
    for r in requested:
        for d in leg["claimDocuments"].get(r["claim"], []):
            if d not in doc_ids:
                doc_ids.append(d)
    docs = [{"id": d, **leg["documents"][d]} for d in doc_ids]
    pull_items: list[str] = []
    for d in docs:
        for f in d["fields"]:
            if f not in pull_items:
                pull_items.append(f)
    hold_items = [f"{labels.get(r['claim'], r['claim'])} = {'참' if r.get('expected', True) else '거짓'}" for r in requested]
    pull_n, hold_n = len(pull_items), len(hold_items)
    reduction = round((1 - hold_n / pull_n) * 100) if pull_n else 0
    return {
        "presetId": preset_id,
        "pullDocuments": docs, "pullItems": pull_items, "pullCount": pull_n,
        "holdItems": hold_items, "holdCount": hold_n,
        "reductionPercent": reduction, "summary": f"이번 검증에서 줄어든 항목: {pull_n} → {hold_n} ({reduction}%)",
        "pullRecords": leg["records"]["pull"], "holdRecords": leg["records"]["hold"],
        "honestyNote": HONESTY,
    }
