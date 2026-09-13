# 진행 기록

## 2026-09-14
- 저장소 뼈대, 데이터(기준 중위소득 2026 고시 확인·정책 9종·합성 시민 30명·기댓값 270건)
- `packages/rules` Python·TS: JSON Logic 부분집합 엔진, 번들 해시 `0x0d3e9975…9466` 양쪽 일치. 테스트 Py 15 / TS 38
- `packages/vc` TS·Python: did:key, VC/VP JWS, Bitstring Status List, JCS. 테스트 TS 58 / Py 72, 교차 픽스처 검증
- `services/issuer`, `services/verifier`: 발급·폐기·검증·공격 시연. 테스트 통과 (Python 총 98)
- `packages/ledger-client`, `scripts/seed_ledger.py`, `docker-compose.yml`(격리), `Makefile`, `docs/DEMO.md`, `docs/DECISIONS.md`
- 진행 중: `chain/`(컨트랙트·배포·Besu), `services/ai`, `apps/wallet`, `apps/verifier`
- `chain/`: Hardhat 3 + 컨트랙트 4종 (테스트 30건), 배포·시드·PII 스캔. Besu QBFT 4노드 실기동 검증
- 통합 스모크(`scripts/smoke_e2e.sh`): Hardhat 에서 발급→혼합 제출 PASS(8.8ms)→폐기 REVOKED→공격 4종 차단→벤치 50회 p95 13ms→PII 스캔 PASS
- `services/ai`: 테스트 56건. Python 전체 154건 통과
- `apps/wallet`(테스트 27) · `apps/verifier`(테스트 16): 빌드·린트·타입체크 통과
- Playwright E2E `apps/e2e`: 시연 ①~⑤ 자동 재현 8.5초 (발급 9장 → 추천 3건 → 제출 PASS → 폐기 후 REVOKED → 공격 4종 차단 → 이력 원장 대조), 스크린샷 14장
- `docs/TEST_REPORT.md`, `docs/DEMO_RUN.md` 생성. 남은 것: PWA 오프라인, 다크모드, 사용성 평가(고령자 5명), 실제 LLM 키로 채팅 품질 확인
