"""전처리 → claim 판정 → 정책 판정, 범주값 프로필."""
from __future__ import annotations

import os
from datetime import date
from typing import Any

from .jsonlogic import evaluate

DEFAULT_EVAL_DATE = "2026-09-14"


def eval_date_from_env(bundle: dict) -> date:
    env = bundle.get("preprocess", {}).get("evalDateEnv", "RULE_EVAL_DATE")
    return date.fromisoformat(os.environ.get(env, DEFAULT_EVAL_DATE))


def _age_on(birth: str, as_of: date) -> int:
    b = date.fromisoformat(birth)
    years = as_of.year - b.year
    if (as_of.month, as_of.day) < (b.month, b.day):
        years -= 1
    return years


def _get(data: dict, path: str) -> Any:
    cur: Any = data
    for part in path.split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
    return cur


def preprocess(bundle: dict, profile: dict, as_of: date | None = None) -> dict:
    """원본 프로필에 파생값을 합쳐 규칙 입력 데이터를 만든다. 원본은 변경하지 않는다."""
    as_of = as_of or eval_date_from_env(bundle)
    data: dict = dict(profile)
    for d in bundle["preprocess"]["derived"]:
        op = d["op"]
        if op == "ageOn":
            data[d["name"]] = _age_on(data[d["from"]], as_of)
        elif op == "birthYear":
            data[d["name"]] = int(str(data[d["from"]])[:4])
        elif op == "get":
            data[d["name"]] = _get(data, d["path"])
        elif op == "clampInt":
            v = int(data[d["from"]])
            data[d["name"]] = max(int(d["min"]), min(int(d["max"]), v))
        elif op == "lookup":
            key = evaluate(d["keyExpr"], data)
            table = bundle["tables"][d["table"]]
            skey = str(key)
            if skey not in table:
                raise KeyError(f"lookup {d['table']}[{skey}] missing")
            data[d["name"]] = table[skey]
        elif op == "expr":
            data[d["name"]] = evaluate(d["expr"], data)
        else:
            raise ValueError(f"unknown preprocess op {op}")
    return data


def evaluate_claims(bundle: dict, profile: dict, as_of: date | None = None,
                    only: list[str] | None = None) -> dict[str, bool]:
    data = preprocess(bundle, profile, as_of)
    rules = bundle["claims"]["rules"]
    names = only or list(rules.keys())
    out: dict[str, bool] = {}
    for name in names:
        v = evaluate(rules[name], data)
        if not isinstance(v, bool):
            raise TypeError(f"claim {name} must evaluate to boolean")
        out[name] = v
    return out


def evaluate_policies(bundle: dict, claims: dict[str, bool]) -> dict[str, bool]:
    """claim 불리언만으로 정책 적격 판정. 원본 프로필 불필요 (검증기관도 실행 가능)."""
    out: dict[str, bool] = {}
    for pid, rule in bundle["policies"]["rules"].items():
        v = evaluate(rule, claims)
        if not isinstance(v, bool):
            raise TypeError(f"policy {pid} must evaluate to boolean")
        out[pid] = v
    return out


def categorical_profile(claims: dict[str, bool], household_size: int) -> dict:
    """AI 서비스에 전달 가능한 범주값. 원본 수치는 절대 포함하지 않는다."""
    if claims.get("incomeBelow32Median"):
        bracket = "≤32%"
    elif claims.get("incomeBelow48Median"):
        bracket = "≤48%"
    elif claims.get("incomeBelow50Median"):
        bracket = "≤50%"
    else:
        bracket = ">50%"
    if claims.get("isBenefitRecipient"):
        status = "recipient"
    elif claims.get("incomeBelow50Median"):
        status = "near-poor"
    else:
        status = "none"
    return {
        "ageBand": "65+" if claims.get("ageOver65") else "<65",
        "householdSize": max(1, min(6, int(household_size))),
        "residence": "daegu" if claims.get("daeguResident") else "other",
        "incomeBracket": bracket,
        "recipientStatus": status,
        "creditTier": "bottom20" if claims.get("creditBottom20") else "other",
    }
