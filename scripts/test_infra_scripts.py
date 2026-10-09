"""시연·리포트 인프라 스크립트 회귀 테스트 (서버·체인 없이 실행).
F15 smoke 폐기 대상 · F16 포트 선점 · F17 compose 배포 경로 · F24 ⑦ 별도 test · F26/F27 E2E 단언 범위 · F45 p95 ·
F50 격리 대조군 · F51/F58 compose · F52 캡처 · F53 vitest 결과 · F54 .env.example
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
from pathlib import Path
from typing import ClassVar

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"_infra_{name}", SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------- F45 bench: 최근접 순위 p95, 첫 1회·흐름 시간 분리 ----------
def test_bench_percentile_nearest_rank():
    bench = load("bench_verify")
    vals = [float(i) for i in range(1, 51)]  # 1..50
    assert bench.percentile(vals, 0.95) == 48.0  # ceil(0.95*50)=48번째 (이전 코드는 int(47.5)-1 → 47번째)
    assert bench.percentile([float(i) for i in range(1, 21)], 0.95) == 19.0
    assert bench.percentile([7.0], 0.95) == 7.0
    assert bench.percentile(vals, 0.5) == 25.0
    with pytest.raises(ValueError):
        bench.percentile([], 0.95)


def test_bench_summary_reports_scope_first_and_flow():
    bench = load("bench_verify")
    totals = [900.0] + [10.0] * 49  # 첫 제출만 느림 (콜드)
    flows = [t + 5 for t in totals]
    out = bench.summarize(totals, flows, [8.0] * 50, {"PASS": 50}, 50)
    assert out["firstMs"] == 900.0
    assert out["p95Ms"] == 10.0 and out["flowP95Ms"] == 15.0
    assert out["pass"] is True
    assert "캐시" in out["scope"] and "앵커" in out["scope"]


# ---------- F53 make_report: 옛 vitest 결과로 성공 보고 금지 ----------
def test_vitest_result_requires_exit_code_and_success(tmp_path):
    rep = load("make_report")
    f = tmp_path / "output.json"
    assert rep.vitest_result(0, f)["ok"] is False  # 결과 파일 없음 → 실패
    f.write_text(json.dumps({"success": True, "numTotalTests": 3, "numFailedTests": 0}))
    assert rep.vitest_result(1, f)["ok"] is False  # 종료 코드 실패면 success 가 참이어도 실패
    assert rep.vitest_result(0, f)["ok"] is True
    f.write_text(json.dumps({"numTotalTests": 3}))
    assert rep.vitest_result(0, f)["ok"] is False  # success 키가 없으면 성공으로 보지 않는다


def test_vitest_summary_unlinks_stale_output(monkeypatch, tmp_path):
    rep = load("make_report")
    out = tmp_path / "pkg" / ".vitest/json/output.json"
    out.parent.mkdir(parents=True)
    out.write_text(json.dumps({"success": True}))  # 9/14 의 옛 결과
    monkeypatch.setattr(rep, "ROOT", tmp_path)
    monkeypatch.setattr(rep, "run", lambda cmd, cwd=None: (1, "vitest: command not found"))
    res = rep.vitest_summary("@dbp/x", "pkg")
    assert res["ok"] is False and not out.exists()


# ---------- F24 make_report: ⑦ 실행 여부를 Playwright JSON 으로 ----------
def _pw_report(down_status: str, main_status: str = "passed") -> dict:
    def t(title, status):
        return {"title": title, "tests": [{"status": "skipped" if status == "skipped" else "expected",
                                           "results": [{"status": status}]}]}
    return {"suites": [{"title": "demo-flow.spec.ts", "specs": [t("①~⑥ 시연 흐름 + ⑤ 폐기·공격 4종", main_status),
                                                                t("⑦ 발급기관 정지 후 검증 PASS", down_status)], "suites": []}],
            "stats": {"startTime": "2026-10-09T09:00:00.000Z", "expected": 1, "skipped": 1,
                      "unexpected": 0 if main_status == "passed" else 1, "flaky": 0}}


def test_e2e_summary_marks_issuer_down_skipped(tmp_path):
    rep = load("make_report")
    rj = tmp_path / "results.json"
    rj.write_text(json.dumps(_pw_report("skipped")), encoding="utf-8")
    s = rep.e2e_summary(rj, tmp_path / ".last-run.json")
    assert s["ok"] is True and s["issuerDown"] == "skipped"
    row = rep.e2e_row(s)
    assert "⑦ 건너뜀" in row and "✅" not in row  # ⑦ 미실행이면 '⑦ 포함 통과'로 쓰지 않는다

    rj.write_text(json.dumps(_pw_report("passed")), encoding="utf-8")
    s = rep.e2e_summary(rj, tmp_path / ".last-run.json")
    assert s["issuerDown"] == "passed" and rep.e2e_row(s).endswith("| ✅ |")

    rj.write_text(json.dumps(_pw_report("skipped", main_status="failed")), encoding="utf-8")
    s = rep.e2e_summary(rj, tmp_path / ".last-run.json")
    assert s["ok"] is False and rep.e2e_row(s).endswith("| ❌ |")


def test_e2e_summary_falls_back_to_last_run_without_claiming_step7(tmp_path):
    rep = load("make_report")
    last = tmp_path / ".last-run.json"
    last.write_text(json.dumps({"status": "passed", "failedTests": []}))
    s = rep.e2e_summary(tmp_path / "missing.json", last)
    assert s["issuerDown"] == "unknown"
    assert "실행 여부 모름" in rep.e2e_row(s) and "✅" not in rep.e2e_row(s)
    assert rep.e2e_summary(tmp_path / "a.json", tmp_path / "b.json") is None


# ---------- F50 격리 프로브: 대조군이 실패하면 exit 2, 발급기관이 꺼져 있으면 '통과'하지 않는다 ----------
def test_isolation_control_requires_issuers_up(capsys):
    probe = load("isolation_probe")
    assert probe.control(opener=lambda url, data=None, headers=None: (False, "URLError: refused")) == 2
    assert "대조군 실패" in capsys.readouterr().out
    assert probe.control(opener=lambda url, data=None, headers=None: (True, '{"ok":true}')) == 0


def test_isolation_probe_blocked_vs_reachable():
    probe = load("isolation_probe")
    only_chain = lambda url, data=None, headers=None: (url == probe.CHAIN, "x")
    assert probe.isolation(opener=only_chain) == 0
    everything = lambda url, data=None, headers=None: (True, "x")
    assert probe.isolation(opener=everything) == 1  # 발급기관에 닿으면 격리 실패
    nothing = lambda url, data=None, headers=None: (False, "x")
    assert probe.isolation(opener=nothing) == 1  # 원장에도 못 닿으면 실패


# ---------- F54 seed: 이미 등록된 키와 로컬 키 비교 ----------
class _Acct:
    def __init__(self, address):
        self.address = address


class _FakeLedger:
    registry: ClassVar[dict] = {}
    lists: ClassVar[dict] = {}

    def __init__(self, rpc_url=None, private_key=None):
        self.account = _Acct("0x" + (private_key or "").removeprefix("0x")[-40:].upper())
        self.deployment = type("D", (), {"chain_id": 31337})()

    def is_connected(self):
        return True

    def issuer_exists(self, did):
        return did in self.registry

    def get_issuer(self, did):
        return self.registry[did]

    def register_issuer(self, did, pub, name, controller):
        self.registry[did] = {"ed25519PubKey": pub, "controller": controller}
        return "0xtx"

    def has_bundle(self, bundle, version):
        return False

    def register_bundle(self, *a):
        return "0xtx"

    def get_status_list(self, list_id):
        if list_id not in self.lists:
            raise RuntimeError("revert: unknown list")
        return self.lists[list_id]

    def publish_status_list(self, list_id, encoded, version):
        self.lists[list_id] = {"version": version, "owner": self.account.address}
        return "0xtx"


@pytest.fixture
def seed(monkeypatch, tmp_path):
    mod = load("seed_ledger")
    _FakeLedger.registry, _FakeLedger.lists = {}, {}
    monkeypatch.setattr(mod, "LedgerClient", _FakeLedger)
    monkeypatch.chdir(tmp_path)
    for v in ("GOVERNANCE_PRIVATE_KEY", "ISSUER_EVM_PRIVATE_KEY_DAEGU", "ISSUER_EVM_PRIVATE_KEY_WELFARE",
              "ISSUER_ED25519_SEED_DAEGU", "ISSUER_ED25519_SEED_WELFARE"):
        monkeypatch.delenv(v, raising=False)
    return mod


def test_seed_is_idempotent_when_keys_match(seed):
    assert seed.main() == 0
    assert seed.main() == 0  # 두 번째 실행: 모두 skip
    assert (Path("chain/deployments/seed-summary.json")).exists()


def test_seed_stops_when_registered_controller_differs(seed, monkeypatch, capsys):
    assert seed.main() == 0
    # 복지기관 키를 대구시 키(hardhat #1)로 잘못 export 한 경우 (.env.example 의 옛 오류)
    monkeypatch.setenv("ISSUER_EVM_PRIVATE_KEY_WELFARE", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
    assert seed.main() == 2
    err = capsys.readouterr().err
    assert "did:dbp:welfare" in err and "컨트롤러" in err and "dbp:status:welfare:list-1" in err


def test_seed_treats_empty_env_as_default(seed, monkeypatch):
    monkeypatch.setenv("GOVERNANCE_PRIVATE_KEY", "")
    monkeypatch.setenv("ISSUER_EVM_PRIVATE_KEY_DAEGU", "")
    from dbp_issuer.config import DEFAULT_EVM_KEYS
    assert seed.issuer_keys("daegu")[1] == DEFAULT_EVM_KEYS["daegu"]
    assert seed.main() == 0


# ---------- F54 .env.example 가 실제 코드와 맞는다 ----------
def _env_example() -> dict[str, str]:
    out = {}
    for line in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def test_env_example_matches_code():
    from dbp_issuer.config import DEFAULT_EVM_KEYS, ISSUER_NAMES
    env = _env_example()
    assert env["ISSUER_ID"] in ISSUER_NAMES
    assert "imbank" not in (ROOT / ".env.example").read_text(encoding="utf-8").split("ISSUER_ID", 1)[1].splitlines()[0]
    assert env["ISSUER_EVM_PRIVATE_KEY_DAEGU"] == DEFAULT_EVM_KEYS["daegu"]
    assert env["ISSUER_EVM_PRIVATE_KEY_WELFARE"] == DEFAULT_EVM_KEYS["welfare"]
    # 검증기관 키는 발급기관 컨트롤러 키와 겹치면 안 된다 (hardhat #3)
    assert env["VERIFIER_EVM_PRIVATE_KEY"] not in DEFAULT_EVM_KEYS.values()
    assert "VERIFIER_DID" not in env  # 코드가 읽지 않는 변수
    assert env.get("ALLOWED_ORIGINS", "x") != ""  # 빈 값이면 CORS 가 전부 막힌다


# ---------- F17 · F51 · F58 compose ----------
def test_compose_binds_loopback_and_keeps_host_deployments():
    yaml = pytest.importorskip("yaml")
    text = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    for name, svc in doc["services"].items():
        for port in svc.get("ports", []):
            assert str(port).startswith("127.0.0.1:"), (name, port)  # LAN 에 RPC·서비스 노출 금지
        for vol in svc.get("volumes", []) or []:
            assert not str(vol).startswith("./chain/deployments"), (name, vol)  # 호스트 latest.json 덮어쓰기 금지
    assert "deployments" in doc["volumes"]
    for name in ("issuer-daegu", "issuer-welfare", "verifier", "ai"):
        env = doc["services"][name]["environment"]
        assert env["HOST"] == "0.0.0.0", name
        assert "http://localhost:3000" in env["ALLOWED_ORIGINS"], name
    assert "격리 시연 전용" in text


def test_compose_config_validates():
    try:
        r = subprocess.run(["docker", "compose", "config", "-q"], cwd=ROOT, capture_output=True, text=True, timeout=60, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pytest.skip("docker CLI 없음")
    assert r.returncode == 0, r.stderr


def test_makefile_documents_compose_as_isolation_only_and_runs_control():
    mk = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert re.search(r"^compose-up: ## \[격리 시연 전용\]", mk, re.MULTILINE)
    iso = mk.split("demo-isolation:", 1)[1].split("\n\n", 1)[0]
    assert iso.index("python - control") < iso.index("exec -T verifier")  # 대조군 먼저
    assert "0-9" in mk.split("help:", 1)[1].splitlines()[1]  # e2e 처럼 숫자가 든 타깃도 도움말에 나온다


# ---------- 셸 스크립트 ----------
@pytest.mark.parametrize("sh", sorted(p.name for p in SCRIPTS.glob("*.sh")))
def test_shell_syntax(sh):
    r = subprocess.run(["bash", "-n", str(SCRIPTS / sh)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr


def test_smoke_revokes_welfare_vc_at_welfare_issuer():
    smoke = (SCRIPTS / "smoke_e2e.sh").read_text(encoding="utf-8")
    assert 'httpx.post(f"{B}/admin/credentials/' in smoke  # incomeBelow50Median 은 복지기관 발급 (F15)
    assert "{D}/admin/credentials" not in smoke
    revoke = smoke.split('{B}/admin/credentials/', 1)[1].split("\n", 2)
    assert "raise_for_status()" in revoke[1]
    assert "X-Counter-Token" in smoke  # GET /results 는 창구 토큰으로만


def test_demo_and_smoke_check_ports_and_liveness():
    demo = (SCRIPTS / "demo.sh").read_text(encoding="utf-8")
    for port in ("8001", "8002", "8003", "8004"):
        assert re.search(rf"require_free {port}\b", demo), port  # F16
    assert "kill -0" in demo
    # 서비스 포트 검사는 체인 배포보다 먼저
    assert demo.index("require_free 8002") < demo.index("deploy:localhost")
    assert "①~⑦" in demo and "⑤ 폐기는 ⑦" in demo  # F06 안내 문구
    smoke = (SCRIPTS / "smoke_e2e.sh").read_text(encoding="utf-8")
    assert "SMOKE_DAEGU_PORT:-8101" in smoke and "kill -0" in smoke


def test_capture_isolation_replaces_outputs_only_after_success():
    sh = (SCRIPTS / "capture_isolation.sh").read_text(encoding="utf-8")
    assert "mkdir -p .demo" in sh  # F52
    assert sh.index('tee "$TMP_TXT"') < sh.index('mv "$TMP_TXT" "$OUT_TXT"')
    assert sh.index("playwright screenshot") < sh.index('mv "$TMP_TXT" "$OUT_TXT"')


# ---------- F24 · F26 · F27 E2E spec ----------
def test_e2e_spec_scopes_assertions():
    spec = (ROOT / "apps/e2e/tests/demo-flow.spec.ts").read_text(encoding="utf-8")
    assert "test.skip(!process.env.E2E_ISSUER_DOWN_CMD" in spec and "test('⑦" in spec  # ⑦ 별도 test
    assert "if (process.env.E2E_ISSUER_DOWN_CMD)" not in spec  # 조용히 건너뛰는 if 블록 없음
    assert "getByTestId('receipt-tx')" in spec
    assert "toContainText(/0x[0-9a-f]{64}/, { timeout: 40_000 }); // 영수증 txHash" not in spec
    assert "attack-card-${kind}" in spec and "attack-result-${kind}" in spec
    assert "getByText(code).first()" not in spec
    assert "getByTestId('confirm-code')" in spec
    for name in ("01-wallet-home", "10-verifier-result-pass", "13-verifier-attacks", "14-wallet-history",
                 "15-verifier-comparison.png", "15b-verifier-comparison-mobile.png", "16-verifier-issuer-down"):
        assert name in spec, name
    cfg = (ROOT / "apps/e2e/playwright.config.ts").read_text(encoding="utf-8")
    assert "'json'" in cfg and "test-results/results.json" in cfg
