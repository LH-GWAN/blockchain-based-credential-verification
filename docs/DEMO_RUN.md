# 시연 실행 기록 (2026-09-14)

`make demo` 상태에서 `make e2e` 로 ①~⑤ 를 자동 재현한 결과와, `make smoke` 헤드리스 통합 결과.

## E2E (Playwright, 헤드리스 Chromium, 지갑 390×844 / 검증기관 1280×860)
- 결과: **통과, 8.5초** (지갑 생성 → 대구광역시·iM뱅크 발급 9장 → AI 추천 3건 → 코드 입력 제출 → 검증 PASS → 폐기 → 재제출 REVOKED → 공격 4종 차단 → 이력 원장 대조 ✓)
- 스크린샷: `docs/screenshots/01…14`

## 헤드리스 통합 (`scripts/smoke_e2e.sh 50`, Hardhat localhost 31337)
| 항목 | 결과 |
|---|---|
| 발급 (대구광역시) | daeguResident, incomeBelow50Median 발급 / incomeBelow32Median 거부 (규칙 기준 미충족) |
| 발급 (iM뱅크) | creditBottom20, annualIncomeUnder35M |
| 혼합 발급기관 제출 | PASS, 8.8ms |
| 폐기 후 재제출 | FAIL [REVOKED], 상태목록 v2 |
| 공격 | replay → NONCE_REUSED · expired → NONCE_EXPIRED · forged → VC_SIG_INVALID+HOLDER_MISMATCH · wrong-holder → HOLDER_MISMATCH |
| 검증 벤치 50회 | 평균 12.2ms · p50 12.1ms · **p95 13.2ms** · 최대 13.5ms (목표 p95 < 2,000ms) |
| PII 스캔 | PASS (blocks=10, txs=9, logs=6, findings=0) |

## Besu QBFT 4-validator (chainId 1337, 2초 블록)
- 배포·시드 성공, 발급 0.7초(블록 대기 포함), 검증 PASS 27.98ms, 제출 영수증 앵커 확인, 폐기 후 REVOKED 15ms, PII 스캔 44블록 findings=0

## 미완료·주의
- `ANTHROPIC_API_KEY` 미설정 상태로 실행해 AI 설명은 템플릿 제공자(`provider: template`)였다. 키를 넣으면 `claude-opus-5` 구조화 출력 경로가 동작하며 인용 검증기가 동일하게 적용된다.
- 고령자 사용성 평가(5명 중 4명 3분 내 완료)는 실시하지 않았다.
- 카메라 QR 스캔은 구현했으나 카메라 없는 환경이라 검증하지 못했다(6자리 코드 입력으로 대체).
