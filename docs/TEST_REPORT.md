# 테스트 리포트

- 생성 시각: 2026-10-09T19:16:48+09:00
- 커밋: `4fda1ef`
- 규칙 번들: `daegu-eligibility@2026.2` 해시 `0xb24ad5f237f4d8ad8694dcfa2b28c88a15c6a9b88faa6764c6907e435509d94e`

## 제안요약서 검증 계획 대응

| 항목 | 기준 | 결과 | 상태 |
|---|---|---|---|
| 판정 일관성 | 합성 시민 30명 × 정책 13개 = 390건, 같은 팀 참조 구현(reference.py)과 일치 — 공식 판정 대비 정확도는 미검증 | Python/TS 엔진 모두 기댓값과 일치 (pytest·vitest 포함) | ✅ |
| 엔진 동등성 | TS/Py 번들 해시 동일 | vitest 해시 검증 | ✅ |
| 개인정보 최소화 | 기관 전달 항목 ≥70% 감소 | 서민금융 상담 대상 확인: 13개 → 2개 (85% 감소) · 햇살론 일반보증 대상 확인: 10개 → 1개 (90% 감소) · 햇살론 일반보증 · 신용 하위 20% 고객: 10개 → 1개 (90% 감소) · 새희망홀씨 대상 확인: 10개 → 1개 (90% 감소) · 새희망홀씨 · 신용 하위 20% 고객: 10개 → 1개 (90% 감소) · 공공요금 감면 대상 확인: 13개 → 1개 (92% 감소) | ✅ |
| 보안 | 위조·만료·폐기·재사용·타인 증명서·비활성 발급기관 차단 | services/verifier 테스트 | ✅ |
| AI 신뢰성·PII 차단 | 인용 검증, 환각 프로브, 페이로드 allowlist | services/ai 테스트 | ✅ |
| 검증 성능 | p95 < 2,000ms | p95 12.5ms, 평균 10.6ms (50회, hardhat-localhost) · 첫 1회 23.5ms · 요청 생성+VP 서명 포함 p95 13.8ms — 측정 범위: 검증 서버 처리(POST /present 왕복) — 로컬 루프백, 같은 VC 2장 반복 제출(규칙 번들 60초·발급기관 5초 캐시, 상태 목록은 매번 원장 조회). QR·화면·영수증 앵커 제외 | ✅ |
| 원장 무기록 | 체인 calldata·이벤트에 PII 0건 (탐지 범위·한계: chain/README.md 'PII 스캔') | chain/scripts/scan-pii.ts | 미실행 |
| 시연 재현 | ①~⑥(③′ 재사용·⑥ 비교 패널 포함) + 공격 4종 자동 재현, ⑦ 발급기관 정지(E2E_ISSUER_DOWN_CMD 지정 시) | Playwright `apps/e2e` (마지막 실행: passed, 2026-10-09T10:15:53.389Z · ⑦ 실행·통과) | ✅ |
| 네트워크 격리 | 검증기관 컨테이너 → 발급기관 차단, 원장만 접근 | `make demo-isolation` 프로브 (통과, docs/screenshots/17-isolation-terminal.txt) | ✅ |

## 스위트별 결과

- Python (pytest): {'ok': True, 'tests': 427, 'failures': 0, 'errors': 0}
- @dbp/rules (vitest): {'ok': True, 'tests': 94, 'failures': 0}
- @dbp/vc (vitest): {'ok': True, 'tests': 93, 'failures': 0}
- @dbp/chain (hardhat): {'ok': True, 'passing': 38, 'failing': 0}

## 개인정보 최소화 상세 (조회형 vs 보유형, data/comparison.json)

```json
{
  "pass": true,
  "scenarios": {
    "서민금융 상담 대상 확인": {
      "benefitPassCount": 2,
      "reductionPercent": 85,
      "pullCount": 13
    },
    "햇살론 일반보증 대상 확인": {
      "benefitPassCount": 1,
      "reductionPercent": 90,
      "pullCount": 10
    },
    "햇살론 일반보증 · 신용 하위 20% 고객": {
      "benefitPassCount": 1,
      "reductionPercent": 90,
      "pullCount": 10
    },
    "새희망홀씨 대상 확인": {
      "benefitPassCount": 1,
      "reductionPercent": 90,
      "pullCount": 10
    },
    "새희망홀씨 · 신용 하위 20% 고객": {
      "benefitPassCount": 1,
      "reductionPercent": 90,
      "pullCount": 10
    },
    "공공요금 감면 대상 확인": {
      "benefitPassCount": 1,
      "reductionPercent": 92,
      "pullCount": 13
    }
  },
  "legacyCount": null
}
```

