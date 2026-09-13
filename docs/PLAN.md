# 작업 계획 (프롬프트 §13 기준)

기준일 2026-09-14. 제출 마감 2026-09-20 23:59.

## P0 — 없으면 제출 불가
- [x] 저장소 뼈대 (pnpm workspace, uv workspace, .env.example, .gitignore)
- [x] `data/`: 기준 중위소득 2026(고시 확인 완료), 정책 13종(개정: 은행 서민금융·민간 감면 추가), 합성 시민 30명, 기댓값 390건
- [x] `packages/rules/py`: JSON Logic 부분집합 엔진, 번들 조합·해시, 참조 구현, 테스트 14건
- [x] `packages/rules/ts`: Python 과 동일 의미의 TS 미러 (해시 동일성 테스트)
- [x] `packages/vc`: did:key, VC/VP JWS(EdDSA), Bitstring Status List, JCS 해시 (TS/Py 교차 검증)
- [x] `chain/`: 컨트랙트 4종 + 테스트 + 배포·시드 + PII 스캔 + Besu compose
- [x] `packages/ledger-client/py`: web3.py 래퍼 (작성됨, 배포 후 통합 테스트)
- [x] `services/issuer`: 발급·폐기·관리, 동의 영수증 앵커, 규칙 해시 대조
- [x] `services/verifier`: 요청·제출 검증·결과·공격 시연, 제출 영수증 앵커
- [x] `services/ai`: 추천(구조화 출력+인용 검증+템플릿 폴백), 채팅, 감사 페이로드
- [x] `apps/wallet`: 시작/발급/추천/제출/이력
- [x] `apps/verifier`: 요청 생성/결과/공격 시연
- [x] `docker-compose.yml`, `Makefile`, `docs/DEMO.md`, `README.md`

## P1
- [x] Besu QBFT 전환, 네트워크 격리 시연
- [x] 채팅 스트리밍 + 환각 프로브 + 프롬프트 캐싱
- [x] 성능 벤치, PII 항목 계산, `make report` → `docs/TEST_REPORT.md`
- [x] Playwright E2E
- [x] 지갑 제출 이력 영수증 대조, "AI가 받은 정보 보기"
- [x] `docs/ARCHITECTURE.md`

## P2
- [x] 카메라 QR (구현, 미검증)  ·  [ ] PWA 오프라인  ·  [ ] 다크모드  ·  [x] 정책 9개
