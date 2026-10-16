"""실행: uv run --with pandas --with scipy --with python-synthpop python scripts/synthetic/synth_mdis.py <MDIS_CSV> [출력폴더]

가계금융복지조사 2025 가구마스터(공공용) → 비수도권 가구 → 반반 분할 → A로 CART 합성 → B(보지 않은 실제)와 비교.

원자료는 이 스크래치 폴더 밖으로 내보내지 않는다(국가통계 자료제공 규정 제17조). 결과는 집계 지표·그림만 남긴다.
"""
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import ks_2samp
from synthpop import CARTMethod, DataProcessor

warnings.filterwarnings("ignore")
import sys
REPO = Path(__file__).resolve().parents[2]
RAW = Path(sys.argv[1])  # MDIS 가계금융복지조사 2025 가구마스터(공공용) CSV — 저장소에 포함하지 않음
HERE = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / ".synthetic"
HERE.mkdir(exist_ok=True)
SEED = 42

raw = pd.read_csv(RAW, encoding="cp949")
cols = {
    "가구원수": "hh_size", "가구주_만연령": "head_age",
    "경상소득(보완)": "income", "경상소득_근로소득(보완)": "inc_wage", "경상소득_사업소득(보완)": "inc_biz",
    "경상소득_공적이전소득(보완)": "inc_public", "자산": "assets", "부채": "debt", "순자산": "net_assets",
    "가구주_성별코드": "head_sex", "가구주_혼인상태코드": "head_marital", "입주형태통합코드": "tenure",
    "한부모가구여부": "single_parent", "노인가구여부": "elderly_hh", "장애인가구여부(2012년~)(보완)": "disabled_hh",
}
num_cols = ["hh_size", "head_age", "income", "inc_wage", "inc_biz", "inc_public", "assets", "debt", "net_assets"]
cat_cols = ["head_sex", "head_marital", "tenure", "single_parent", "elderly_hh", "disabled_hh"]

df = raw[raw["수도권여부"] == "G2"][list(cols)].rename(columns=cols).reset_index(drop=True)  # G2 = 비수도권
for c in cat_cols:
    df[c] = df[c].astype(str)
for c in num_cols:
    df[c] = pd.to_numeric(df[c])

rng = np.random.default_rng(SEED)
idx = rng.permutation(len(df))
A = df.iloc[idx[: len(df) // 2]].reset_index(drop=True)   # 학습용 실제
B = df.iloc[idx[len(df) // 2:]].reset_index(drop=True)    # 보지 않은 실제

meta = {c: "numerical" for c in num_cols} | {c: "categorical" for c in cat_cols}
proc = DataProcessor(meta)
A_p = proc.preprocess(A)
cart = CARTMethod(meta, smoothing=False, proper=True, minibucket=5, random_state=SEED)
cart.fit(A_p)
S = proc.postprocess(cart.sample(len(A)))
for c in num_cols:
    S[c] = pd.to_numeric(S[c])
S["hh_size"] = S["hh_size"].round().clip(1, 10).astype(int)
S["head_age"] = S["head_age"].round().astype(int)

# 프라이버시 처리: 학습 실제 행과 완전히 같은 합성 행 제거 (R synthpop의 replicated uniques 제거와 같은 취지)
_key = num_cols + cat_cols
_train = set(A[_key].astype(str).agg("|".join, axis=1))
_dup = S[_key].astype(str).agg("|".join, axis=1).isin(_train)
removed_copies = int(_dup.sum())
S = S[~_dup].reset_index(drop=True)

# ── 판정 규칙(가구 경상소득·순자산 기준 근사) ──
median = json.loads((REPO / "data/median-income-2026.json").read_text())["byHouseholdSize"]
def rules(d: pd.DataFrame) -> pd.DataFrame:
    med = d["hh_size"].clip(1, 6).astype(str).map(lambda k: int(median[k]))
    monthly = d["income"] * 10000 / 12
    return pd.DataFrame({
        "중위소득 50% 이하": monthly * 100 <= med * 50,
        "연소득 3,500만 이하 (햇살론)": d["income"] <= 3500,
        "연소득 4,000만 이하 (새희망홀씨)": d["income"] <= 4000,
        "버팀목 (5천만·순자산 3.45억)": (d["income"] <= 5000) & (d["net_assets"] <= 34500),
        "디딤돌 (6천만·순자산 5.11억)": (d["income"] <= 6000) & (d["net_assets"] <= 51100),
        "65세 이상 가구주": d["head_age"] >= 65,
    })

rate = pd.DataFrame({
    "실제 A (학습)": rules(A).mean() * 100,
    "실제 B (보지 않음)": rules(B).mean() * 100,
    "합성 S": rules(S).mean() * 100,
}).round(1)
rate["S−B (%p)"] = (rate["합성 S"] - rate["실제 B (보지 않음)"]).round(1)
rate["A−B (%p, 표본 오차 기준)"] = (rate["실제 A (학습)"] - rate["실제 B (보지 않음)"]).round(1)

# ── 분포 비교: KS 통계량(작을수록 비슷), 기준선 = 실제 A vs 실제 B ──
ks = pd.DataFrame({
    "KS 합성 vs B": [ks_2samp(S[c], B[c]).statistic for c in num_cols],
    "KS 실제A vs B": [ks_2samp(A[c], B[c]).statistic for c in num_cols],
    "중앙값 B": [B[c].median() for c in num_cols],
    "중앙값 S": [S[c].median() for c in num_cols],
}, index=num_cols).round(3)

# ── 변수 관계: 스피어만 상관행렬 평균 절대 차이 ──
corr = lambda d: d[num_cols].corr(method="spearman")
corr_SB = float((corr(S) - corr(B)).abs().values[np.triu_indices(len(num_cols), 1)].mean())
corr_AB = float((corr(A) - corr(B)).abs().values[np.triu_indices(len(num_cols), 1)].mean())

# ── 프라이버시: 합성 행이 학습 실제 행과 완전히 같은 경우 ──
key = num_cols + cat_cols
exact = int(S[key].astype(str).agg("|".join, axis=1).isin(set(A[key].astype(str).agg("|".join, axis=1))).sum())

out = {
    "source": "국가데이터처 MDIS 가계금융복지조사 2025 가구마스터(공공용), 비수도권 가구",
    "n_total": len(df), "n_A": len(A), "n_B": len(B), "n_S": len(S),
    "method": "python-synthpop 0.1.2 CARTMethod(smoothing=False, proper, minibucket=5), seed 42",
    "eligibility_rates": rate.reset_index().rename(columns={"index": "기준"}).to_dict(orient="records"),
    "ks": ks.reset_index().rename(columns={"index": "변수"}).to_dict(orient="records"),
    "corr_mean_abs_diff": {"S_vs_B": round(corr_SB, 3), "A_vs_B": round(corr_AB, 3)},
    "removed_exact_copies": removed_copies, "exact_copies_after_removal": exact,
}
(HERE / "result.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
S.to_csv(HERE / "synthetic_nonmetro_households.csv", index=False, encoding="utf-8-sig")
print(rate.to_string()); print(); print(ks.to_string()); print()
print("corr diff S-B", round(corr_SB, 3), " A-B", round(corr_AB, 3), " removed", removed_copies, " remaining exact", exact, " n_S", len(S))
