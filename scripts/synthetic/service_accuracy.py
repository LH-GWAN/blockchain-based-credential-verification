"""실행: uv run python scripts/synthetic/service_accuracy.py [synth_mdis.py 출력 폴더]

합성 6,207가구로 '서비스 정확도' 측정 — 실제 프로토타입 코드(판정 엔진·VC 발급·VP·검증)를 그대로 호출한다.

원장만 메모리 스텁(공개키·상태목록·규칙 해시)으로 바꾼다. 네트워크·체인 지연은 이 측정에 들어가지 않는다.
정답(ground truth) = 독립 참조 구현(packages/rules reference.py, JSON Logic 미사용)이 가구의 실제 값으로 계산한 자격.

측정:
 1) 판정 일관성: 엔진 판정 == 참조 판정 (가구 × 항목)
 2) 정상 제출: 자격 있는 항목을 본인이 제출 → PASS 여야 함 (FAIL = 오거절)
 3) 자격 없는 항목에 대한 부정 시도 → FAIL 이어야 함 (PASS = 오승인)
    a. 위조: 공격자 키로 '참' 증명서를 직접 서명
    b. 도용: 자격 있는 다른 사람의 증명서를 자기 VP 에 넣어 제출
 4) 폐기: 발급된 증명서 중 5% 를 폐기 → 제출 시 FAIL 이어야 함
 5) 재제출: 같은 VP 를 두 번 → 두 번째 FAIL 이어야 함
"""
from __future__ import annotations

import csv
import json
import random
import statistics
import sys
import time
from datetime import date
from pathlib import Path

from dbp_rules import bundle_hash, evaluate_claims, load_bundle
from dbp_rules.engine import eval_date_from_env
from dbp_rules.reference import reference_claims
from dbp_vc import create_status_list, create_vp, encode_status_list, generate_holder_key, issue_vc
from dbp_vc.statuslist import set_status
from dbp_verifier.verify import verify_presentation

REPO = Path(__file__).resolve().parents[2]
HERE = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / ".synthetic"  # synth_mdis.py 출력 폴더
SEED = 7
rnd = random.Random(SEED)

bundle = load_bundle()
BH = bundle_hash(bundle)
AS_OF = eval_date_from_env(bundle)
issuer_of = bundle["claims"]["issuerOf"]
median = json.loads((REPO / "data/median-income-2026.json").read_text())["byHouseholdSize"]
tables = bundle["tables"]
pension = {"singleKRW": tables["basicPensionLineByHouseholdKind"]["single"],
           "coupleKRW": tables["basicPensionLineByHouseholdKind"]["couple"]}

# 공공용 자료로 값을 만들 수 있는 항목만 측정 (수급 여부·학생 자녀·신용은 자료에 없음, 거주는 전원 대구로 가정해 제외)
CLAIMS = ["ageOver65", "daeguMetroFreeAge", "singlePersonHousehold", "incomeBelow32Median", "incomeBelow48Median",
          "incomeBelow50Median", "incomeBelowBasicPensionLine", "annualIncomeUnder35M", "annualIncomeUnder40M",
          "annualIncomeUnder45M", "annualIncomeUnder50M"]

# ── 합성 가구 → 시민 프로필 ──
rows = list(csv.DictReader(open(HERE / "synthetic_nonmetro_households.csv", encoding="utf-8-sig")))
citizens = []
for i, r in enumerate(rows):
    age = int(float(r["head_age"]))
    income_manwon = max(0, int(round(float(r["income"]))))
    citizens.append({
        "citizenId": f"S-{i:05d}", "birthDate": date(AS_OF.year - age, 1, 1).isoformat(),
        "residence": {"sido": "대구광역시", "sigungu": "북구"}, "householdSize": int(float(r["hh_size"])),
        "monthlyIncomeKRW": income_manwon * 10000 // 12, "annualIncomeKRW": income_manwon * 10000,
        "isBasicLivelihoodRecipient": False, "hasStudentChild": False, "creditScoreTier": "other",
    })

# ── 발급기관 2곳 + 원장 스텁 ──
ISSUERS = {}
for name, did, seed in [("대구광역시", "did:dbp:daegu", 11), ("사회보장정보원(복지기관)", "did:dbp:welfare", 12)]:
    k = generate_holder_key(bytes([seed]) * 32)
    ISSUERS[did] = {"key": k, "name": name, "controller": f"0x{seed:040x}", "lists": {}}
LIST_BITS = 131072


class StubLedger:
    def get_issuer(self, did):
        i = ISSUERS[did]
        return {"did": did, "ed25519PubKey": i["key"].public_key, "name": i["name"], "controller": i["controller"],
                "active": True, "registeredAt": 0}

    def get_bundle(self, b, v):
        return {"bundleHash": BH, "schemaHash": "0x" + "00" * 32, "by": "0x0", "at": 0}

    def get_status_list(self, list_id):
        did, n = list_id.rsplit("#", 1)
        bits = ISSUERS[did]["lists"][int(n)]
        return {"encodedList": encode_status_list(bits), "version": 1, "updatedAt": 0, "owner": ISSUERS[did]["controller"]}


ledger = StubLedger()
counters = {did: 0 for did in ISSUERS}


def alloc(did):
    n = counters[did]; counters[did] += 1
    li, idx = divmod(n, LIST_BITS)
    ISSUERS[did]["lists"].setdefault(li, create_status_list(LIST_BITS))
    return f"{did}#{li}", idx


def issue(holder, claim):
    did = issuer_of[claim]
    list_id, idx = alloc(did)
    jwt = issue_vc(id=f"urn:uuid:{holder.did[-12:]}-{claim}", issuer_did=did, issuer_kid=did + "#key-1",
                   issuer_private_key=ISSUERS[did]["key"].private_key, holder_did=holder.did,
                   claim={"name": claim, "value": True}, valid_from="2026-01-01T00:00:00Z",
                   valid_until="2026-12-31T23:59:59Z", status={"listId": list_id, "index": idx},
                   evidence={"bundle": bundle["bundle"], "version": bundle["version"], "bundleHash": BH})
    return jwt, (did, list_id, idx)


VERIFIER = "did:dbp:verifier-imbank-branch-01"
used = set()


def present(holder, vcs, claim):
    nonce = f"n{rnd.getrandbits(64):x}"
    vp = create_vp(holder_did=holder.did, holder_private_key=holder.private_key, verifier_did=VERIFIER, nonce=nonce, vc_jwts=vcs)
    return vp, nonce


def verify(vp, nonce, claim):
    def lookup(n):
        if n != nonce:
            return "unknown"
        if n in used:
            return "used"
        used.add(n); return "ok"
    t = time.perf_counter()
    out = verify_presentation(vp, verifier_did=VERIFIER, requested=[{"claim": claim, "expected": True}], nonce_lookup=lookup,
                              ledger=ledger, issuer_of=issuer_of, accepted_bundles={bundle["bundle"]: [bundle["version"]]})
    return out, (time.perf_counter() - t) * 1000


stats = {"households": len(citizens), "claims_measured": CLAIMS,
         "consistency": {"total": 0, "agree": 0}, "honest": {"total": 0, "pass": 0, "false_reject": 0},
         "forged": {"total": 0, "blocked": 0, "false_accept": 0}, "borrowed": {"total": 0, "blocked": 0, "false_accept": 0},
         "revoked": {"total": 0, "blocked": 0}, "replay": {"total": 0, "blocked": 0}, "reasons": {}}
lat = []
attacker = generate_holder_key(bytes([0xAA]) * 32)
issued_pool = {c: [] for c in CLAIMS}   # claim -> [(holder, vc)]
holders = []

t0 = time.time()
for c in citizens:
    h = generate_holder_key(rnd.getrandbits(256).to_bytes(32, "big"))
    holders.append(h)
    eng = evaluate_claims(bundle, c, AS_OF)
    ref = reference_claims(c, median, pension, AS_OF)
    for claim in CLAIMS:
        stats["consistency"]["total"] += 1
        stats["consistency"]["agree"] += int(bool(eng[claim]) == bool(ref[claim]))
        if eng[claim] is True:  # 발급기관: 참일 때만 발급
            vc, loc = issue(h, claim)
            issued_pool[claim].append((h, vc, loc))
            vp, nonce = present(h, [vc], claim)
            out, ms = verify(vp, nonce, claim)
            lat.append(ms)
            stats["honest"]["total"] += 1
            ok = out.verdict == "PASS"
            stats["honest"]["pass"] += ok
            stats["honest"]["false_reject"] += (not ok) and bool(ref[claim])
            if not ok:
                for rc in out.reason_codes:
                    stats["reasons"][rc] = stats["reasons"].get(rc, 0) + 1
            # 재제출: 같은 VP 를 다시
            if rnd.random() < 0.05:
                out2, _ = verify(vp, nonce, claim)
                stats["replay"]["total"] += 1
                stats["replay"]["blocked"] += out2.verdict != "PASS"

# 자격 없는 항목에 대한 부정 시도
for c, h in zip(citizens, holders):
    ref = reference_claims(c, median, pension, AS_OF)
    for claim in CLAIMS:
        if ref[claim]:
            continue
        did = issuer_of[claim]
        forged = issue_vc(id=f"urn:uuid:forged-{claim}", issuer_did=did, issuer_kid=did + "#key-1",
                          issuer_private_key=attacker.private_key, holder_did=h.did, claim={"name": claim, "value": True},
                          valid_from="2026-01-01T00:00:00Z", valid_until="2026-12-31T23:59:59Z",
                          status={"listId": f"{did}#0", "index": 0},
                          evidence={"bundle": bundle["bundle"], "version": bundle["version"], "bundleHash": BH})
        vp, nonce = present(h, [forged], claim)
        out, _ = verify(vp, nonce, claim)
        stats["forged"]["total"] += 1
        stats["forged"]["blocked"] += out.verdict != "PASS"
        stats["forged"]["false_accept"] += out.verdict == "PASS"
        if issued_pool[claim]:
            _, other_vc, _ = rnd.choice(issued_pool[claim])
            vp, nonce = present(h, [other_vc], claim)
            out, _ = verify(vp, nonce, claim)
            stats["borrowed"]["total"] += 1
            stats["borrowed"]["blocked"] += out.verdict != "PASS"
            stats["borrowed"]["false_accept"] += out.verdict == "PASS"

# 폐기: 발급된 증명서 5%
all_issued = [x for v in issued_pool.items() for x in [(v[0],) + t for t in v[1]]]
for claim, h, vc, (did, list_id, idx) in rnd.sample(all_issued, max(1, len(all_issued) // 20)):
    li = int(list_id.rsplit("#", 1)[1])
    set_status(ISSUERS[did]["lists"][li], idx, True)
    vp, nonce = present(h, [vc], claim)
    out, _ = verify(vp, nonce, claim)
    stats["revoked"]["total"] += 1
    stats["revoked"]["blocked"] += out.verdict != "PASS"

s = sorted(lat)
stats["latency_ms"] = {"n": len(s), "mean": round(statistics.mean(s), 2), "p50": round(s[len(s) // 2], 2),
                       "p95": round(s[int(len(s) * 0.95) - 1], 2), "max": round(s[-1], 2),
                       "scope": "검증 함수 처리만(프로세스 내, 원장은 메모리 스텁) — 네트워크·체인 지연 제외"}
stats["vcs_issued"] = len(all_issued)
stats["elapsed_s"] = round(time.time() - t0, 1)
stats["notes"] = ["정답 = 독립 참조 구현(reference.py)이 합성 가구의 실제 값으로 계산한 자격",
                  "거주는 전원 대구로 가정, 수급·학생 자녀·신용 항목은 공공용 자료에 없어 제외",
                  "소득은 가구 경상소득 기준"]
(HERE / "service_accuracy.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2))
print(json.dumps(stats, ensure_ascii=False, indent=2))
