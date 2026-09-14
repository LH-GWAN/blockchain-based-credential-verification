"""테스트 리포트 생성 → docs/TEST_REPORT.md
- Python 테스트(pytest --junitxml), TS 패키지 테스트(vitest --reporter=json), 컨트랙트 테스트(hardhat)
- 판정 정확성(270건), 개인정보 최소화 지표, (있으면) 검증 성능 벤치 결과 docs/bench.json
실행: uv run python scripts/make_report.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/TEST_REPORT.md"
TMP = ROOT / ".report"
TMP.mkdir(exist_ok=True)


def run(cmd: list[str], cwd: Path = ROOT) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr)


def pytest_summary() -> dict:
    xml = TMP / "pytest.xml"
    code, out = run(["uv", "run", "pytest", "-q", f"--junitxml={xml}"])
    if not xml.exists():
        return {"ok": False, "error": out[-2000:]}
    suites = ET.parse(xml).getroot()
    tests = int(suites.get("tests") or sum(int(s.get("tests", 0)) for s in suites))
    fails = int(suites.get("failures") or sum(int(s.get("failures", 0)) for s in suites))
    errors = int(suites.get("errors") or sum(int(s.get("errors", 0)) for s in suites))
    return {"ok": code == 0, "tests": tests, "failures": fails, "errors": errors}


def vitest_summary(pkg: str, path: str) -> dict:
    outfile = ROOT / path / ".vitest/json/output.json"
    code, out = run(["pnpm", "--filter", pkg, "exec", "vitest", "run", "--reporter=json", f"--outputFile={outfile}"])
    try:
        js = json.loads(outfile.read_text(encoding="utf-8"))
        return {"ok": bool(js.get("success", code == 0)), "tests": js.get("numTotalTests"), "failures": js.get("numFailedTests")}
    except Exception:
        return {"ok": code == 0, "raw": out[-800:]}


def hardhat_summary() -> dict:
    code, out = run(["pnpm", "--filter", "@dbp/chain", "test"])
    import re
    m_pass = re.search(r"(\d+) passing", out)
    m_fail = re.search(r"(\d+) failing", out)
    return {"ok": code == 0, "passing": int(m_pass[1]) if m_pass else 0, "failing": int(m_fail[1]) if m_fail else 0}


def main() -> int:
    exp = json.loads((ROOT / "data/expected.json").read_text(encoding="utf-8"))
    code, pii_out = run(["uv", "run", "python", "scripts/pii_items.py"])
    comp = json.loads((ROOT / "data/comparison.json").read_text(encoding="utf-8")) if (ROOT / "data/comparison.json").exists() else {"presets": {}}
    pii = {"pass": comp.get("pass", False), "scenarios": {v.get("label", k): {"benefitPassCount": v["holdCount"], "reductionPercent": v["reductionPercent"], "pullCount": v["pullCount"]} for k, v in comp["presets"].items()}, "legacyCount": None}
    py = pytest_summary()
    ts_rules = vitest_summary("@dbp/rules", "packages/rules/ts")
    ts_vc = vitest_summary("@dbp/vc", "packages/vc/ts")
    hh = hardhat_summary()
    bench = json.loads((ROOT / "docs/bench.json").read_text()) if (ROOT / "docs/bench.json").exists() else None
    last = ROOT / "apps/e2e/test-results/.last-run.json"
    e2e = json.loads(last.read_text()) if last.exists() else None
    commit = run(["git", "rev-parse", "--short", "HEAD"])[1].strip()
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    def mark(ok):
        return "✅" if ok else "❌"

    lines = [
        "# 테스트 리포트", "",
        f"- 생성 시각: {now}", f"- 커밋: `{commit}`", f"- 규칙 번들: `{exp['bundle']}@{exp['version']}` 해시 `{exp['bundleHash']}`", "",
        "## 제안요약서 검증 계획 대응", "",
        "| 항목 | 기준 | 결과 | 상태 |", "|---|---|---|---|",
        f"| 판정 정확성 | 합성 시민 {exp['citizenCount']}명 × 정책 {exp['policyCount']}개 = {exp['verdictCount']}건 100% 일치 | Python/TS 엔진 모두 기댓값과 일치 (pytest·vitest 포함) | {mark(py.get('ok') and ts_rules.get('ok'))} |",
        f"| 엔진 동등성 | TS/Py 번들 해시 동일 | vitest 해시 검증 | {mark(ts_rules.get('ok'))} |",
        f"| 개인정보 최소화 | 기관 전달 항목 ≥70% 감소 | " + " · ".join(f"{k}: {v['pullCount']}개 → {v['benefitPassCount']}개 ({v['reductionPercent']}% 감소)" for k, v in (pii.get('scenarios') or {}).items()) + f" | {mark(pii.get('pass'))} |",
        f"| 보안 | 위조·만료·폐기·재사용·타인 증명서·비활성 발급기관 차단 | services/verifier 테스트 | {mark(py.get('ok'))} |",
        f"| AI 신뢰성·PII 차단 | 인용 검증, 환각 프로브, 페이로드 allowlist | services/ai 테스트 | {mark(py.get('ok'))} |",
        f"| 검증 성능 | p95 < 2,000ms | {('p95 ' + str(bench.get('p95Ms')) + 'ms, 평균 ' + str(bench.get('meanMs')) + 'ms (' + str(bench.get('runs')) + '회)') if bench else '미측정 (scripts/bench_verify.py 실행 필요)'} | {mark(bench and bench.get('p95Ms', 9999) < 2000)} |",
        f"| 원장 무기록 | 체인 calldata·이벤트에 PII 0건 | chain/scripts/scan-pii.ts | {bench.get('piiScan', '미실행') if bench else '미실행'} |",
        f"| 시연 재현 | ①~⑦ 전 과정(③′ 재사용·⑥ 비교 패널·⑦ 발급기관 정지 포함) + 공격 4종 자동 재현 | Playwright `apps/e2e` (마지막 실행: {e2e.get('status') if e2e else '미실행'}) | {mark(e2e and e2e.get('status') == 'passed')} |",
        "", "## 스위트별 결과", "",
        f"- Python (pytest): {py}", f"- @dbp/rules (vitest): {ts_rules}", f"- @dbp/vc (vitest): {ts_vc}", f"- @dbp/chain (hardhat): {hh}", "",
        "## 개인정보 최소화 상세 (조회형 vs 보유형, data/comparison.json)", "", "```json", json.dumps(pii, ensure_ascii=False, indent=2), "```", "",
    ]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
