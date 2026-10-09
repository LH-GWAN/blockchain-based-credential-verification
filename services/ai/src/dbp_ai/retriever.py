"""정책 문서 저장소와 검색기.

MVP 는 정책이 10개 이하이므로 벡터 DB 없이 정책 문서 전체를 컨텍스트에 넣는다 (in-context retrieval).
확장 경로: `Retriever` 프로토콜을 구현한 클래스(예: 임베딩 검색)로 `InContextRetriever` 를 교체하면
프롬프트 빌더(`prompts.py`)는 그대로 쓸 수 있다.

프롬프트에 넣는 필드는 name·category·agency·summary·howToApply·legalBasis(clauseId·title·text)·notes 뿐이다.
`sourceUrl` 은 넣지 않는다 — 모델에 필요 없고, 게시글 번호 같은 7자리 이상 숫자가 들어 있어 PII 검사(원본 금액 0건)와 충돌한다.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from dbp_rules import load_policies

# 제도명으로 볼 만한 어절의 접미사. 검증기가 "정책 DB 에 없는 제도명" 을 찾을 때 쓴다.
PROGRAM_SUFFIXES = ("수당", "급여", "바우처", "연금", "대출", "지원금", "보조금", "장려금", "감면", "교통카드", "확인서",
                    "계좌", "적금")  # "청년도약계좌"·"청년희망적금" 같은 미등록 금융 상품명도 잡는다 (F23)
_PROGRAM_TERM_RE = re.compile(
    r"(?P<stem>[가-힣A-Za-z0-9·]*?)(?P<suffix>" + "|".join(PROGRAM_SUFFIXES) + r")"
)

# 정책별 별칭 — 템플릿 상담이 "어떤 제도를 묻는가" 를 판단하고, 검증기가 표기 변형을 허용하는 데 쓴다.
POLICY_ALIASES: dict[str, list[str]] = {
    "basic-pension": ["기초연금", "기초 연금", "노령연금"],
    "daegu-metro-free": [
        "어르신 통합무임 교통카드", "통합무임 교통카드", "통합무임교통카드", "무임 교통카드", "무임교통카드",
        "도시철도 무임", "도시철도무임", "어르신 교통카드", "지하철 무임",
    ],
    "energy-voucher": ["에너지바우처", "에너지 바우처"],
    "micro-livelihood-loan": ["소액생계비대출", "소액생계비 대출", "소액생계비", "불법사금융예방대출", "불법사금융 예방대출"],
    "nbl-education": ["교육급여", "교육 급여"],
    "nbl-housing": ["주거급여", "주거 급여"],
    "nbl-livelihood": ["생계급여", "생계 급여"],
    "near-poor": ["차상위계층 확인", "차상위계층 확인서", "차상위계층", "차상위"],
    # 2026.1.2 개편으로 근로자햇살론·햇살론뱅크가 햇살론 일반보증으로 합쳐졌다. 옛 이름으로 물어도 후속 상품을 안내한다.
    "sunshine-loan-general": ["햇살론 일반보증", "햇살론일반보증", "햇살론뱅크", "햇살론 뱅크", "근로자햇살론", "근로자 햇살론"],
    # 일반어 "요금감면" 은 별칭으로 두지 않는다 — "전기요금 감면" 질문이 통신요금으로 잡히면
    # 대상이 다른 제도(전기: 수급자·50% 이하 / 통신: 기초연금 수급자 포함)의 판정을 전하게 된다.
    "telecom-discount": ["통신요금 감면", "통신요금감면", "통신비 감면", "통신비감면", "이동통신 요금감면", "휴대폰 요금 감면"],
    "electricity-welfare-discount": ["전기요금 감면", "전기요금 할인", "전기료 감면", "전기료 할인", "한전 복지할인"],
    "city-gas-discount": ["도시가스 요금 감면", "도시가스 요금감면", "가스요금 감면", "가스요금 경감", "가스비 감면"],
}

_PROMPT_FIELDS = ("policyId", "name", "category", "agency", "summary", "howToApply", "notes", "basisVerified",
                  "channel", "welfareMembership", "verifierHint")
_CLAUSE_FIELDS = ("clauseId", "title", "text")


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


def extract_program_terms(text: str) -> list[str]:
    """본문에서 제도명처럼 보이는 어절을 뽑는다. 접미사만 있는 일반 명사("급여", "감면")는 제외한다.

    "생계·의료·주거·교육급여" 처럼 가운뎃점으로 묶인 복합어는 "생계급여", "의료급여", ... 로 펼친다.
    """
    out: list[str] = []
    for m in _PROGRAM_TERM_RE.finditer(text):
        stem, suffix = m.group("stem"), m.group("suffix")
        if not stem:
            continue
        parts = [p for p in stem.split("·") if p]
        if len(parts) > 1:
            out.extend(p + suffix for p in parts)
        out.append(stem.replace("·", "") + suffix)
    return out


class PolicyStore:
    """정책 DB (data/policies/*.json) 의 읽기 전용 인덱스."""

    def __init__(self, policies: Iterable[dict]):
        self.policies: list[dict] = sorted(policies, key=lambda p: p["policyId"])
        self.by_id: dict[str, dict] = {p["policyId"]: p for p in self.policies}
        self.names: list[str] = [p["name"] for p in self.policies]
        self.known_terms: set[str] = self._build_known_terms()

    @classmethod
    def load(cls, root: Path | None = None) -> PolicyStore:
        return cls(load_policies(root))

    # ---- 조회 ----

    def get(self, policy_id: str) -> dict | None:
        return self.by_id.get(policy_id)

    def clause_ids(self, policy_id: str) -> set[str]:
        p = self.by_id.get(policy_id)
        return {c["clauseId"] for c in p["legalBasis"]} if p else set()

    def aliases(self, policy_id: str) -> list[str]:
        p = self.by_id[policy_id]
        return [p["name"], *POLICY_ALIASES.get(policy_id, [])]

    def prompt_docs(self) -> list[dict]:
        """프롬프트용 정책 문서 (allowlist 필드만, sourceUrl 제외)."""
        docs = []
        for p in self.policies:
            d = {k: p.get(k, "") for k in _PROMPT_FIELDS}
            d["legalBasis"] = [{k: c.get(k, "") for k in _CLAUSE_FIELDS} for c in p["legalBasis"]]
            docs.append(d)
        return docs

    def match_policies(self, text: str) -> list[str]:
        """본문이 언급한 등록 정책 ID 목록 (이름·별칭, 공백 무시 비교)."""
        t = _norm(text)
        hits = []
        for p in self.policies:
            pid = p["policyId"]
            if any(_norm(a) in t for a in self.aliases(pid) if a):
                hits.append(pid)
        return hits

    # ---- 제도명 allowlist ----

    def _build_known_terms(self) -> set[str]:
        terms: set[str] = set()
        for p in self.policies:
            terms.add(_norm(p["name"]))
            terms.update(_norm(a) for a in POLICY_ALIASES.get(p["policyId"], []))
            corpus = [p.get("name", ""), p.get("agency", ""), p.get("summary", ""), p.get("howToApply", ""), p.get("notes", ""), p.get("verifierHint", "")]
            corpus += [c.get("title", "") + " " + c.get("text", "") for c in p["legalBasis"]]
            for chunk in corpus:
                terms.update(_norm(t) for t in extract_program_terms(chunk))
        return terms

    def is_known_term(self, term: str) -> bool:
        """정확히 일치할 때만 인정한다 (공백 무시). 부분문자열로 인정하면 "청년기초연금" 이 "기초연금" 으로 통과한다 (F23)."""
        return _norm(term) in self.known_terms

    def unknown_program_terms(self, text: str) -> list[str]:
        """정책 DB 어디에도 근거가 없는 제도명 어절. 하나라도 있으면 해당 추천 항목은 노출하지 않는다."""
        seen: list[str] = []
        for term in extract_program_terms(text):
            if not self.is_known_term(term) and term not in seen:
                seen.append(term)
        return seen


class Retriever(Protocol):
    def retrieve(self, query: str | None = None) -> list[dict]: ...


class InContextRetriever:
    """정책 전체를 그대로 돌려준다 (정책 ≤ 10개). 대체 구현은 query 로 상위 k개만 고르면 된다."""

    def __init__(self, store: PolicyStore):
        self.store = store

    def retrieve(self, query: str | None = None) -> list[dict]:
        return self.store.prompt_docs()


@lru_cache(maxsize=1)
def get_store() -> PolicyStore:
    return PolicyStore.load()
