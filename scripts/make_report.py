"""테스트 리포트 생성 → docs/TEST_REPORT.md
- Python 테스트(pytest --junitxml), TS 패키지 테스트(vitest --reporter=json), 컨트랙트 테스트(hardhat)
- 판정 일관성(엔진 TS·Py ↔ 참조 구현, data/expected.json), 개인정보 최소화 지표, (있으면) 검증 성능 벤치 결과 docs/bench.json
- 시연 재현: Playwright JSON 결과(apps/e2e/test-results/results.json)로 test 별 통과·skipped(⑦) 를 반영
- 스위트 통과 = 종료 코드 0 이면서 결과 파일도 성공. 이전 실행의 결과 파일은 실행 전에 지운다(실행 실패 시 옛 결과를 보고하지 않게).
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
    xml.unlink(missing_ok=True)
    code, out = run(["uv", "run", "pytest", "-q", f"--junitxml={xml}"])
    if not xml.exists():
        return {"ok": False, "error": out[-2000:]}
    suites = ET.parse(xml).getroot()
    tests = int(suites.get("tests") or sum(int(s.get("tests", 0)) for s in suites))
    fails = int(suites.get("failures") or sum(int(s.get("failures", 0)) for s in suites))
    errors = int(suites.get("errors") or sum(int(s.get("errors", 0)) for s in suites))
    return {"ok": code == 0 and fails == 0 and errors == 0, "tests": tests, "failures": fails, "errors": errors}


def vitest_summary(pkg: str, path: str) -> dict:
    outfile = ROOT / path / ".vitest/json/output.json"
    outfile.unlink(missing_ok=True)  # 이전 실행 결과가 남아 있으면 vitest 가 실행되지 않아도 성공으로 읽힌다
    code, out = run(["pnpm", "--filter", pkg, "exec", "vitest", "run", "--reporter=json", f"--outputFile={outfile}"])
    return vitest_result(code, outfile, out)


def vitest_result(code: int, outfile: Path, out: str = "") -> dict:
    """ok = 종료 코드 0 이면서 JSON 의 success 도 참. 결과 파일이 없으면 실패."""
    try:
        js = json.loads(outfile.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": False, "exitCode": code, "raw": out[-800:]}
    return {"ok": code == 0 and js.get("success") is True, "tests": js.get("numTotalTests"), "failures": js.get("numFailedTests")}


def hardhat_summary() -> dict:
    code, out = run(["pnpm", "--filter", "@dbp/chain", "test"])
    import re
    m_pass = re.search(r"(\d+) passing", out)
    m_fail = re.search(r"(\d+) failing", out)
    return {"ok": code == 0, "passing": int(m_pass[1]) if m_pass else 0, "failing": int(m_fail[1]) if m_fail else 0}


def _walk_specs(suite: dict):
    yield from suite.get("specs", [])
    for child in suite.get("suites", []):
        yield from _walk_specs(child)


def e2e_summary(results_json: Path, last_run: Path) -> dict | None:
    """Playwright 결과 요약. ok = 실패·불안정 없이 1개 이상 통과. issuerDown = ⑦ test 의 상태(passed/skipped/failed/absent)."""
    if results_json.exists():
        try:
            js = json.loads(results_json.read_text(encoding="utf-8"))
        except ValueError:
            js = None
        if js is not None:
            tests = []
            for suite in js.get("suites", []):
                for spec in _walk_specs(suite):
                    for t in spec.get("tests", []):
                        res = t.get("results") or []
                        status = res[-1].get("status") if res else ("skipped" if t.get("status") == "skipped" else "absent")
                        tests.append({"title": spec.get("title", ""), "status": status})
            stats = js.get("stats", {})
            passed = [t for t in tests if t["status"] == "passed"]
            bad = [t for t in tests if t["status"] not in ("passed", "skipped")]
            down = next((t["status"] for t in tests if "⑦" in t["title"]), "absent")
            ok = bool(passed) and not bad and not stats.get("unexpected") and not stats.get("flaky")
            return {"status": "passed" if ok else "failed", "ok": ok, "issuerDown": down,
                    "startTime": stats.get("startTime"), "tests": tests}
    if last_run.exists():  # JSON 결과가 없으면 상태만 안다 — ⑦ 실행 여부는 알 수 없음
        st = json.loads(last_run.read_text()).get("status")
        return {"status": st, "ok": st == "passed", "issuerDown": "unknown", "startTime": None, "tests": []}
    return None


E2E_DOWN_KO = {"passed": "⑦ 실행·통과", "skipped": "⑦ 건너뜀(E2E_ISSUER_DOWN_CMD 없음)", "absent": "⑦ 없음",
               "unknown": "⑦ 실행 여부 모름(JSON 결과 없음)"}


def bench_text(bench: dict | None) -> str:
    if not bench:
        return "미측정 (scripts/bench_verify.py 실행 필요)"
    txt = f"p95 {bench.get('p95Ms')}ms, 평균 {bench.get('meanMs')}ms ({bench.get('runs')}회"
    if bench.get("chain"):
        txt += f", {bench['chain']}"
    txt += ")"
    if bench.get("firstMs") is not None:
        txt += f" · 첫 1회 {bench['firstMs']}ms"
    if bench.get("flowP95Ms") is not None:
        txt += f" · 요청 생성+VP 서명 포함 p95 {bench['flowP95Ms']}ms"
    return txt + f" — 측정 범위: {bench.get('scope', '검증 서버 처리(/present 왕복), 로컬, 상태 목록은 매번 원장 조회')}"


def e2e_row(e2e: dict | None) -> str:
    if not e2e:
        return "| 시연 재현 | ①~⑥(③′ 재사용·⑥ 비교 패널 포함) + 공격 4종 자동 재현, ⑦ 발급기관 정지 | Playwright `apps/e2e` (마지막 실행: 미실행) | ❌ |"
    down = e2e["issuerDown"]
    when = f", {e2e['startTime']}" if e2e.get("startTime") else ""
    detail = f"마지막 실행: {e2e['status']}{when} · {E2E_DOWN_KO.get(down, '⑦ ' + str(down))}"
    mark = "✅" if e2e["ok"] and down == "passed" else ("⚠️ ⑦ 제외" if e2e["ok"] else "❌")
    return (f"| 시연 재현 | ①~⑥(③′ 재사용·⑥ 비교 패널 포함) + 공격 4종 자동 재현, ⑦ 발급기관 정지(E2E_ISSUER_DOWN_CMD 지정 시) "
            f"| Playwright `apps/e2e` ({detail}) | {mark} |")


def main() -> int:
    exp = json.loads((ROOT / "data/expected.json").read_text(encoding="utf-8"))
    pii_code, _ = run(["uv", "run", "python", "scripts/pii_items.py"])
    comp = json.loads((ROOT / "data/comparison.json").read_text(encoding="utf-8")) if (ROOT / "data/comparison.json").exists() else {"presets": {}}
    # pii_items.py 가 실패하면 comparison.json 은 이전 결과이므로 통과로 보지 않는다
    pii = {"pass": pii_code == 0 and comp.get("pass", False), "scenarios": {v.get("label", k): {"benefitPassCount": v["holdCount"], "reductionPercent": v["reductionPercent"], "pullCount": v["pullCount"]} for k, v in comp["presets"].items()}, "legacyCount": None}
    py = pytest_summary()
    ts_rules = vitest_summary("@dbp/rules", "packages/rules/ts")
    ts_vc = vitest_summary("@dbp/vc", "packages/vc/ts")
    hh = hardhat_summary()
    bench = json.loads((ROOT / "docs/bench.json").read_text()) if (ROOT / "docs/bench.json").exists() else None
    iso_txt = ROOT / "docs/screenshots/17-isolation-terminal.txt"
    iso = iso_txt.read_text(encoding="utf-8") if iso_txt.exists() else ""
    iso_ok = "격리 검사 통과" in iso
    e2e = e2e_summary(ROOT / "apps/e2e/test-results/results.json", ROOT / "apps/e2e/test-results/.last-run.json")
    commit = run(["git", "rev-parse", "--short", "HEAD"])[1].strip()
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    def mark(ok):
        return "✅" if ok else "❌"

    lines = [
        "# 테스트 리포트", "",
        f"- 생성 시각: {now}", f"- 커밋: `{commit}`", f"- 규칙 번들: `{exp['bundle']}@{exp['version']}` 해시 `{exp['bundleHash']}`", "",
        "## 제안요약서 검증 계획 대응", "",
        "| 항목 | 기준 | 결과 | 상태 |", "|---|---|---|---|",
        f"| 판정 일관성 | 합성 시민 {exp['citizenCount']}명 × 정책 {exp['policyCount']}개 = {exp['verdictCount']}건, 같은 팀 참조 구현(reference.py)과 일치 — 공식 판정 대비 정확도는 미검증 | Python/TS 엔진 모두 기댓값과 일치 (pytest·vitest 포함) | {mark(py.get('ok') and ts_rules.get('ok'))} |",
        f"| 엔진 동등성 | TS/Py 번들 해시 동일 | vitest 해시 검증 | {mark(ts_rules.get('ok'))} |",
        f"| 개인정보 최소화 | 기관 전달 항목 ≥70% 감소 | " + " · ".join(f"{k}: {v['pullCount']}개 → {v['benefitPassCount']}개 ({v['reductionPercent']}% 감소)" for k, v in (pii.get('scenarios') or {}).items()) + f" | {mark(pii.get('pass'))} |",
        f"| 보안 | 위조·만료·폐기·재사용·타인 증명서·비활성 발급기관 차단 | services/verifier 테스트 | {mark(py.get('ok'))} |",
        f"| AI 신뢰성·PII 차단 | 인용 검증, 환각 프로브, 페이로드 allowlist | services/ai 테스트 | {mark(py.get('ok'))} |",
        f"| 검증 성능 | p95 < 2,000ms | {bench_text(bench)} | {mark(bench and bench.get('p95Ms', 9999) < 2000)} |",
        f"| 원장 무기록 | 체인 calldata·이벤트에 PII 0건 (탐지 범위·한계: chain/README.md 'PII 스캔') | chain/scripts/scan-pii.ts | {bench.get('piiScan', '미실행') if bench else '미실행'} |",
        e2e_row(e2e),
        f"| 네트워크 격리 | 검증기관 컨테이너 → 발급기관 차단, 원장만 접근 | `make demo-isolation` 프로브 ({'통과' if iso_ok else '미실행 또는 실패'}, docs/screenshots/17-isolation-terminal.txt) | {mark(iso_ok)} |",
        "", "## 스위트별 결과", "",
        f"- Python (pytest): {py}", f"- @dbp/rules (vitest): {ts_rules}", f"- @dbp/vc (vitest): {ts_vc}", f"- @dbp/chain (hardhat): {hh}", "",
        "## 개인정보 최소화 상세 (조회형 vs 보유형, data/comparison.json)", "", "```json", json.dumps(pii, ensure_ascii=False, indent=2), "```", "",
    ]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
