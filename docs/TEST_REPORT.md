# 테스트 리포트

- 생성 시각: 2026-09-14T23:36:36+09:00
- 커밋: `2fb65af`
- 규칙 번들: `daegu-eligibility@2026.1` 해시 `0x2032a0249e8f763c07de77a046c98dd97a6a0af87cb7ba5a3225e061002adc15`

## 제안요약서 검증 계획 대응

| 항목 | 기준 | 결과 | 상태 |
|---|---|---|---|
| 판정 정확성 | 합성 시민 30명 × 정책 13개 = 390건 100% 일치 | Python/TS 엔진 모두 기댓값과 일치 (pytest·vitest 포함) | ✅ |
| 엔진 동등성 | TS/Py 번들 해시 동일 | vitest 해시 검증 | ✅ |
| 개인정보 최소화 | 기관 전달 항목 ≥70% 감소 | 서민금융 상담 대상 확인: 13개 → 2개 (85% 감소) · 햇살론뱅크 대상 확인: 10개 → 1개 (90% 감소) · 새희망홀씨 대상 확인: 10개 → 1개 (90% 감소) · 공공요금 감면 대상 확인: 13개 → 1개 (92% 감소) | ✅ |
| 보안 | 위조·만료·폐기·재사용·타인 증명서·비활성 발급기관 차단 | services/verifier 테스트 | ✅ |
| AI 신뢰성·PII 차단 | 인용 검증, 환각 프로브, 페이로드 allowlist | services/ai 테스트 | ✅ |
| 검증 성능 | p95 < 2,000ms | p95 13.2ms, 평균 12.4ms (50회) | ✅ |
| 원장 무기록 | 체인 calldata·이벤트에 PII 0건 | chain/scripts/scan-pii.ts | PASS (blocks=80, txs=79, logs=76, findings=0) |
| 시연 재현 | ①~⑦ 전 과정(③′ 재사용·⑥ 비교 패널·⑦ 발급기관 정지 포함) + 공격 4종 자동 재현 | Playwright `apps/e2e` (마지막 실행: passed) | ✅ |
| 네트워크 격리 | 검증기관 컨테이너 → 발급기관 차단, 원장만 접근 | `make demo-isolation` 프로브 (통과, docs/screenshots/17-isolation-terminal.txt) | ✅ |

## 스위트별 결과

- Python (pytest): {'ok': True, 'tests': 155, 'failures': 0, 'errors': 0}
- @dbp/rules (vitest): {'ok': True, 'tests': 38, 'failures': 0}
- @dbp/vc (vitest): {'ok': True, 'tests': 58, 'failures': 0}
- @dbp/chain (hardhat): {'ok': True, 'passing': 30, 'failing': 0}

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
    "햇살론뱅크 대상 확인": {
      "benefitPassCount": 1,
      "reductionPercent": 90,
      "pullCount": 10
    },
    "새희망홀씨 대상 확인": {
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

