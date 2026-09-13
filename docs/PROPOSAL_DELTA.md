# 제안요약서(최종판, 2026-09-14 02:39) ↔ 구현 정합성 점검표

최종판 제안요약서는 구현 결과(정책 13종, 발급기관 2곳, 측정치)를 이미 반영했다. 아래는 문장 단위로 대조한 결과다.

## 일치 확인
| 제안요약서 서술 | 구현 근거 |
|---|---|
| 주요 기능 1 "정책 13종(공공 복지·교통 7 + 은행 서민금융 3 + 민간 감면 3)", 지갑은 은행·민간 창구 혜택 먼저 | `data/policies/*.json` 의 `channel`, 지갑 `/benefits` 3섹션, `docs/screenshots/05-wallet-benefits.png` |
| ④ "발급기관은 대구광역시(주민등록·가구 사실)와 사회보장정보원 모사(수급·소득구간·연소득 사실) 2개" | `services/issuer/src/dbp_issuer/config.py` `ISSUER_KNOWN_FIELDS`, `claims.json` `issuerOf` |
| 3) "신용평점은 은행이 자체 조회하는 정보이므로 증명서로 발급하지 않는다" | `issuerOf.creditBottom20 = "self"`, 발급기관 테스트 `CLAIM_NOT_ISSUED_HERE` |
| 기술 스택: Claude(claude-opus-5)+컨텍스트 주입, JWS 봉투형, Hardhat/Besu QBFT 실기동, OpenID4VCI/VP 미구현, 테스트 Python 154·TS 96·컨트랙트 30 | `services/ai`, `packages/vc`, `chain/besu/README.md`, `docs/TEST_REPORT.md` (TS 96 = rules 38 + vc 58; 앱 테스트 77건은 별도) |
| 4) "10개 → 2개(80%)", "햇살론뱅크 10개 → 1개(90%)", 발급기관·유효상태는 메타데이터 | `scripts/pii_items.py` 두 시나리오 측정, `docs/TEST_REPORT.md` |
| 4) "3분 이내 완료 목표, 사용자 측정은 향후 과제" | `docs/DEMO_RUN.md` 미완료 항목 |
| 5) 시연 시나리오 "햇살론뱅크 상담에서 '연소득 3,500만 원 이하' 한 항목만 제출" | E2E `③'` 단계, `docs/screenshots/10b-verifier-result-sunshine-bank.png` |
| 5) "용도 프리셋 4종(서민금융 상담 · 햇살론뱅크 · 새희망홀씨 · 공공요금 감면)" | `GET /presets` — 이름을 문서에 맞춰 "공공요금 감면 대상 확인"으로 통일(2026-09-14) |
| 5) 검증 결과 표(390건, p95 13.2ms/평균 12.4ms, Besu 28ms, 보안 6종, PII 스캔 블록 80·tx 79·로그 76, E2E 통과) | `docs/TEST_REPORT.md`, `docs/bench.json`, `docs/DEMO_RUN.md` |
| 예상 질의 "iM뱅크·iM저축은행을 검증기관으로 모사" | `services/verifier/src/dbp_verifier/config.py` `VERIFIERS` |

## 남은 미세 차이 (문서 수정 권장)
| 서술 | 실제 | 권장 |
|---|---|---|
| "단계별 스크린샷 14장" | 16장 (복지기관 동의 `03b`, 햇살론뱅크 결과 `10b` 추가) | "16장" 으로 수정 |
| "시연 ①~⑦ 전 과정" | 구조도 흐름 ①~⑦ 은 모두 거치지만, `docs/DEMO.md` 는 시연 단계를 ①~⑤ 로 번호 매김 | 문서에 "구조도 ①~⑦ 흐름" 이라고 명시하거나 DEMO.md 번호와 맞춤 |
| 공격 4종 "위조 서명 · 만료 · 폐기된 증명서 · nonce 재사용" | 검증기관 공격 버튼은 재사용·만료(요청)·위조·타인 증명서 도용 4종이고, 폐기는 별도 단계(⑤)에서 차단 | "위조 · 만료 · 재사용 · 타인 증명서 도용 + 폐기 차단" 으로 표현 |
| 과제요약 "대구시가 판정한 자격" | 발급기관은 대구시 + 복지기관 2곳 (④에서 설명됨) | 그대로 두어도 무방 |
