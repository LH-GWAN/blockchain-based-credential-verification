"""JSON Logic 부분집합 평가기.

지원 연산자: var, if, and, or, !, ==, !=, <, <=, >, >=, in, *, +
설계 원칙 (TS 구현과 동일해야 함):
- and/or/!/if 의 조건은 반드시 불리언. 아니면 TypeError.
- 비교 연산은 정수끼리 또는 문자열끼리(==, != 만). 그 외는 TypeError.
- *, + 는 정수만. float 는 어디서도 허용하지 않는다.
- 없는 변수는 None. None 은 == / != 비교에만 쓸 수 있다.
"""
from __future__ import annotations

from typing import Any

SUPPORTED = ("var", "if", "and", "or", "!", "==", "!=", "<", "<=", ">", ">=", "in", "*", "+")


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _get_var(data: Any, path: str) -> Any:
    cur = data
    for part in str(path).split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _require_bool(v: Any, op: str) -> bool:
    if not isinstance(v, bool):
        raise TypeError(f"'{op}' expects boolean operands, got {type(v).__name__}")
    return v


def _compare(op: str, a: Any, b: Any) -> bool:
    if op in ("==", "!="):
        if _is_int(a) and _is_int(b) or isinstance(a, str) and isinstance(b, str) \
                or isinstance(a, bool) and isinstance(b, bool) or a is None or b is None:
            return (a == b) if op == "==" else (a != b)
        raise TypeError(f"'{op}' operands must be same primitive type")
    if not (_is_int(a) and _is_int(b)):
        raise TypeError(f"'{op}' requires integers")
    return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def evaluate(rule: Any, data: Any) -> Any:
    if isinstance(rule, float):
        raise TypeError("float literal not allowed in rules")
    if not isinstance(rule, dict):
        return rule
    if len(rule) != 1:
        raise ValueError("rule object must have exactly one operator key")
    (op, args), = rule.items()
    if op not in SUPPORTED:
        raise ValueError(f"unsupported operator: {op}")
    if not isinstance(args, list):
        args = [args]

    if op == "var":
        return _get_var(data, args[0])
    if op == "if":
        if len(args) != 3:
            raise ValueError("'if' requires [cond, then, else]")
        cond = _require_bool(evaluate(args[0], data), "if")
        return evaluate(args[1] if cond else args[2], data)
    if op == "and":
        return all(_require_bool(evaluate(a, data), "and") for a in args)
    if op == "or":
        return any(_require_bool(evaluate(a, data), "or") for a in args)
    if op == "!":
        return not _require_bool(evaluate(args[0], data), "!")
    if op in ("==", "!=", "<", "<=", ">", ">="):
        if len(args) != 2:
            raise ValueError(f"'{op}' requires exactly 2 operands")
        return _compare(op, evaluate(args[0], data), evaluate(args[1], data))
    if op == "in":
        needle, hay = evaluate(args[0], data), evaluate(args[1], data)
        if not isinstance(hay, list):
            raise TypeError("'in' requires a list")
        return needle in hay
    if op in ("*", "+"):
        vals = [evaluate(a, data) for a in args]
        if not all(_is_int(v) for v in vals):
            raise TypeError(f"'{op}' requires integers")
        acc = 1 if op == "*" else 0
        for v in vals:
            acc = acc * v if op == "*" else acc + v
        return acc
    raise AssertionError("unreachable")
