"""네트워크 격리 프로브 (docker compose 스택 전용 — make demo 의 호스트 프로세스와는 별개 인스턴스를 검사한다).

1) 대조군: 발급기관 컨테이너(net-issuer) 안에서 실행해 발급기관 2곳이 실제로 떠 있고 응답하는지 확인한다.
   발급기관이 꺼져 있으면 '차단됨'이 격리 덕분인지 알 수 없으므로 exit 2 로 멈춘다.
     docker compose exec -T issuer-welfare python - control < scripts/isolation_probe.py
2) 본 검사: 검증기관 컨테이너 안에서 실행 — 발급기관에는 닿지 않고(차단), 공동원장에는 닿는다(허용).
     docker compose exec -T verifier python - < scripts/isolation_probe.py
`make demo-isolation` 이 1) → 2) 순서로 실행한다. 시연 ⑦ 에서는 발급기관을 정지하기 전에 실행한다.
"""
import sys
import urllib.request

ISSUERS = [
    ("issuer-daegu:8001/health  ", "http://issuer-daegu:8001/health"),
    ("issuer-welfare:8003/health", "http://issuer-welfare:8003/health"),
]
CHAIN = "http://chain:8545"


def reach(url, data=None, headers=None):
    """(성공 여부, 응답 앞부분 또는 오류 설명)."""
    try:
        req = urllib.request.Request(url, data=data, headers=headers or {})
        return True, urllib.request.urlopen(req, timeout=3).read().decode()[:80]
    except Exception as e:  # noqa: BLE001
        return False, type(e).__name__ + ": " + str(e)[:90]


def probe(label, url, failed, data=None, headers=None, expect_blocked=False, opener=reach):
    ok, info = opener(url, data, headers)
    if ok:
        print(("❌ 접속됨(격리 실패): " if expect_blocked else "✅ 접근 가능: ") + label + " → " + info)
        if expect_blocked:
            failed.append(label)
    else:
        print(("✅ 차단됨: " if expect_blocked else "❌ 접근 실패: ") + label + " → " + info)
        if not expect_blocked:
            failed.append(label)


def control(opener=reach) -> int:
    print("[대조군] 발급기관 컨테이너(net-issuer)에서 실행 — 발급기관이 떠 있어야 격리 검사가 의미 있다")
    failed: list = []
    for label, url in ISSUERS:
        probe("issuer → " + label + " (발급기관, 응답해야 함)", url, failed, opener=opener)
    if failed:
        print("대조군 실패: 발급기관이 응답하지 않아 격리 여부를 판단할 수 없습니다 (발급기관 기동 후 다시 실행)")
        return 2
    print("대조군 통과: 발급기관 2곳이 같은 망에서는 응답한다")
    return 0


def isolation(opener=reach) -> int:
    print("[본 검사] 검증기관 컨테이너(verifier)에서 실행 — 검증기관은 net-issuer 에 속하지 않는다 (compose 인스턴스)")
    failed: list = []
    for label, url in ISSUERS:
        probe("verifier → " + label + " (발급기관, 차단되어야 함)", url, failed, expect_blocked=True, opener=opener)
    probe("verifier → chain:8545 eth_chainId      (공동원장, 허용되어야 함)", CHAIN, failed, opener=opener,
          data=b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', headers={"content-type": "application/json"})
    if failed:
        print("격리 검사 실패:", len(failed), "건")
        return 1
    print("격리 검사 통과: 검증기관은 발급기관에 닿지 않고 원장에만 닿는다")
    return 0


if __name__ == "__main__":
    sys.exit(control() if sys.argv[1:] == ["control"] else isolation())
