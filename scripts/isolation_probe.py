"""검증기관 컨테이너 안에서 실행: 발급기관에는 닿지 않고(차단), 공동원장에는 닿는다(허용).
사용: docker compose exec -T verifier python - < scripts/isolation_probe.py
"""
import sys
import urllib.request

FAILED = []


def probe(label, url, data=None, headers=None, expect_blocked=False):
    try:
        req = urllib.request.Request(url, data=data, headers=headers or {})
        body = urllib.request.urlopen(req, timeout=3).read().decode()[:80]
        print(("❌ 접속됨(격리 실패): " if expect_blocked else "✅ 접근 가능: ") + label + " → " + body)
        if expect_blocked:
            FAILED.append(label)
    except Exception as e:  # noqa: BLE001
        print(("✅ 차단됨: " if expect_blocked else "❌ 접근 실패: ") + label + " → " + type(e).__name__ + ": " + str(e)[:90])
        if not expect_blocked:
            FAILED.append(label)


print("검증기관 컨테이너(verifier)에서 실행 — 검증기관은 net-issuer 에 속하지 않는다")
probe("verifier → issuer-daegu:8001/health   (발급기관, 차단되어야 함)", "http://issuer-daegu:8001/health", expect_blocked=True)
probe("verifier → issuer-welfare:8003/health (발급기관, 차단되어야 함)", "http://issuer-welfare:8003/health", expect_blocked=True)
probe("verifier → chain:8545 eth_chainId     (공동원장, 허용되어야 함)", "http://chain:8545",
      data=b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', headers={"content-type": "application/json"})

if FAILED:
    print("격리 검사 실패:", len(FAILED), "건")
    sys.exit(1)
print("격리 검사 통과: 검증기관은 발급기관에 닿지 않고 원장에만 닿는다")
