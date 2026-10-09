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

## 2026-09-14 (아이디어 개정 반영)
- 제안 초점 변경: "공공이 판정한 자격을 은행·저축은행 창구에서 소득 노출 없이 증명". 복지멤버십이 하는 공공 복지 안내는 다시 만들지 않음
- 발급기관 = 공공만 (대구광역시 + 사회보장정보원 모사). iM뱅크 발급기관 제거, 은행은 검증기관. 신용평점은 `issuerOf: self`(창구 자체 조회)
- 정책 9 → 13 (햇살론뱅크·새희망홀씨·전기요금 복지할인·도시가스 경감 추가), `channel`/`welfareMembership`/`verifierHint` 필드. 판정 390건 100% 일치, 번들 해시 `0x2032a0…dc15`
- 검증기관: 은행·저축은행 프로필 + 용도 프리셋 4종(`GET /presets`), `policyCheck` 결과. AI: 채널 우선순위·창구 제출 안내 규칙
- 지갑: 창구 혜택 안내 3섹션·창구 제출 증명서 안내 (테스트 41). 검증기관 앱: 프리셋 칩·정책 판정 재현 카드·저축은행 (테스트 36)
- 개정 E2E 통과 10.6초, 벤치 p95 13ms, PII 스캔 0건. `docs/TEST_REPORT.md`·`docs/DEMO_RUN.md`·스크린샷 갱신

## 2026-09-14 (2차 개정: 조회형 → 보유형)
- 프레임 재정의(D-18): "종이 없애기" 폐기, 3성질(참·거짓만 / 1회 발급 N회 제출 / 검증이 이력을 남기지 않음) 중심. README·DEMO·스토리보드 갱신, 금지 문구 테스트 추가
- 비교 패널(§12.5): `data/legacy-documents.json` → `scripts/pii_items.py` → `data/comparison.json`; 검증 서비스 `comparison` 블록·`GET /comparison`; 검증기관 앱 "같은 상담, 두 경로 비교" 패널(모바일 세로 스택). 햇살론뱅크 10→1 (90%)
- E2E 확장: ⑥ 패널·감소율 검증, ③′ iM저축은행+새희망홀씨 재사용(재발급 0건 확인), ⑦ 발급기관 정지 후 PASS(`E2E_ISSUER_DOWN_CMD`). 스크린샷 10c·15·15b·16 추가
- 미완료: 실제 LLM 키 품질 확인(키 없음), 시연 영상(선택), 사용성 평가
- compose 격리 프로브(`make demo-isolation`) 실행 → 초기 토폴로지 격리 실패 검출 → 수정 후 통과, `17-isolation-terminal.png` 확보 (D-20). Dockerfile: 빌드 시 solc 컴파일, UV_NO_SYNC, data 복사

## 2026-09-15
- LLM 키는 선택 항목으로 유지하기로 결정(키 미투입). 기본 시연 모드 = 템플릿 제공자
- 지갑 화면 정리(디자인 검토 피드백): QR 붙여넣기 칸의 JSON 예시 삭제, "규칙 버전 2026.1 · 해시 일치 ✓" → "해시 일치 ✓", "규칙 기준 미충족" → "해당하지 않음"(추가 서류가 아니라 조건 불충족임을 안내문으로 설명)
- 기술 정보 노출 축소: 사전 판정·증명서 "자세히"·영수증 원문을 표(`DataTable`/`DetailTable`)로 표시, 원문 JSON 은 접힌 "기술 정보" 안으로. E2E 가 표 행(사전 판정·증명 내용·영수증 종류)을 검사
- E2E 를 장시간 기동 스택에서도 통과하도록 수정: ③′ 재사용 건수는 전후 비교, ⑤ 폐기 대상은 이번 실행의 최신 증명서. 통과 11.6초, 스크린샷 갱신

## 2026-10-09 (서민금융 상품 현행화, D-21)
- 코드 리뷰 1순위 반영: 햇살론뱅크는 2026.1.2 개편으로 햇살론 일반보증(근로자햇살론과 통합, 은행·저축은행 등 전 금융업권 취급)이 되었다. 정책 `sunshine-loan-bank` → `sunshine-loan-general`, 규칙식은 그대로. 재직·사업 3개월 이상과 소득 증빙 요건은 창구 자체 확인으로 정책 문서에 명시
- 새희망홀씨 규칙을 현행 기준(연소득 4,000만 원 이하 OR 신용 하위 20% AND 5,000만 원 이하)으로 수정. 복지기관 발급 사실 `annualIncomeUnder40M`·`annualIncomeUnder50M` 추가, 김복례 발급 사실 9 → 11개
- 규칙 번들 `daegu-eligibility` 2026.1 → 2026.2 (해시 `0xb1eb8e28…f102`), 참조 구현·기댓값 재생성: 판정 390건 중 C-010·C-028 새희망홀씨만 거짓 → 참. 규칙 엔진 Python·TS 테스트 통과
- 검증기관: 프리셋 `sunshine-bank` → `sunshine-general`("햇살론 일반보증 대상 확인"), 새희망홀씨 프리셋은 연소득 4,000만 원 1항목. 프리셋별 `verifierKinds`(새희망홀씨 = 은행만), 미취급 창구 요청은 `PRESET_NOT_OFFERED`
- 시연 ③′ 변경: iM저축은행 + 새희망홀씨 → iM저축은행 + 햇살론 일반보증(③과 같은 증명서, 재발급 없음). 비교 패널 숫자는 그대로(10→1 90%, 13→2 85%, 13→1 92%)
- 문서: README·DEMO·스토리보드·ARCHITECTURE·DECISIONS(D-21 추가, D-04·D-10·D-15·D-16·D-17·D-19 에 날짜 주석)·PROPOSAL_DELTA 갱신. `docs/TEST_REPORT.md`·`docs/DEMO_RUN.md`·스크린샷은 E2E 재실행 후 다시 생성한다

## 2026-10-09 (규칙 데이터 정정, D-22)
- 코드 리뷰 2순위(F04·F05·F14) 반영. 기준 중위소득 5·6인을 고시 제2025-135호 값(7,556,719원·8,555,952원)으로 정정, 7인 이상 → 6인 값 판정을 MVP 한계로 문서화. 경계값 시민 C-011·C-012 소득을 새 48% 선으로 재생성
- 전기요금 복지할인 = 수급자 OR 차상위(기초연금 경로 제거, 한전 복지할인 대상에 없음). 통신요금 감면 = 수급자 OR 차상위 OR (65세 이상 AND 기초연금 선정기준액 이하), 근거 조항 `telecom-discount-c3`(복지로: 이용료 50%, 월 최대 11,000원)
- 정책 문서 `requiredClaims` → `requiredClaimSets`(OR 분기마다 증명 조합, anyOf). 도우미 Python `claim_sets` / TS `claimSetsOf`(옛 형식 호환). 대안 경로를 `verifierHint` 에 안내
- 규칙 엔진 `rule_vars`·`evaluate_policy_partial` 추가. 검증 결과 `policyCheck` 는 미제출 항목을 거짓으로 채우지 않고 `eligible: null` + `pending` 을 돌려준다(수급자가 '50% 이하'만 내면 차상위 적격으로 보이던 오류 수정)
- 검증기관 프리셋 4 → 6종: '햇살론 일반보증 · 신용 하위 20% 고객'(연소득 4,500만 원 1항목), '새희망홀씨 · 신용 하위 20% 고객'(연소득 5,000만 원 1항목, 은행만). 창구가 조회한 신용평점은 `counterChecked` 로 판정 재현에 반영. 비교 패널 두 프리셋 모두 10→1 (90%), 6종 모두 85% 이상
- 판정 390건 재생성: C-013·C-015·C-017 통신요금 거짓 → 참·전기요금 참 → 거짓, C-030 생계급여 참 → 거짓. 김복례(C-001) 변화 없음
- 규칙 번들은 `daegu-eligibility@2026.2` 를 유지하고 해시만 `0xb1eb8e28…f102` → `0xb24ad5f2…d94e`(2026.2 는 지속 원장에 등록된 적이 없음). 리허설 전 지갑 초기화 필요
- 화면: 지갑은 보유 사실로 성립하는 증명 조합을 골라 '창구에 제출할 증명서'를 안내하고, 신용평점은 '창구가 직접 확인 (증명서 아님)'으로 따로 표시. 검증기관 화면은 판정 불가 시 미제출 항목과 창구 자체 확인 항목을 표시. AI 상담 검색에서 일반어 '요금감면' 별칭을 빼, 전기요금 질문이 통신요금 판정으로 연결되던 문제 수정
- 테스트 통과: Python 251 · 규칙 엔진 TS 93 · VC 58 · 체인 30 · 지갑 51 · 검증기관 화면 74. 중위소득표 경계값, 증명 조합의 충분성·필요성(규칙 변수 전 조합), 부분 판정 교차 검증 테스트 추가
- 문서: DECISIONS(D-22 추가, D-06·D-15·D-17·D-19·D-21 에 날짜 주석)·README·ARCHITECTURE·DEMO·스토리보드·PROPOSAL_DELTA·PLAN 갱신. `docs/TEST_REPORT.md`·`docs/DEMO_RUN.md`·스크린샷은 E2E 재실행 후 다시 생성한다

## 2026-10-09 (코드 리뷰 3~6순위, D-23)
- 공개 API 보호: 검증 요청에 창구 토큰(`counterToken`), 결과 조회는 창구 토큰 또는 VP 해시가 있어야 응답(401/403). 6자리 코드는 만료·사용 시 404, 실패 조회가 잦으면 429. 서명·aud 가 맞는 VP 만 nonce 를 소모하고, 그렇지 않은 제출은 `rid#rejected-…` 로 따로 저장(결과 선점 차단). 발급기관 `/admin/*` 은 `ADMIN_TOKEN` 또는 로컬 접속만, 서비스 기본 바인딩 127.0.0.1(`HOST`), CORS 는 `ALLOWED_ORIGINS`. AI 감사 기록은 무작위 `auditId` 로만 조회(`/audit/last-payload` 410)
- 검증 엄격화: 요청 항목 검사(`REQUESTED_INVALID`), claim 별 소관 발급기관 대조(`ISSUER_NOT_AUTHORITATIVE`), 요청하지 않은 증명서 거절(`UNREQUESTED_CREDENTIAL`), 원장 장애 분리(`LEDGER_UNAVAILABLE`), 받는 규칙 버전 목록(`RULE_VERSION_NOT_ACCEPTED`), 상태목록 게시자 대조(`STATUS_LIST_OWNER_MISMATCH`). 체크리스트 8 → 11개(`issuerActive`·`notExpired`·`issuerAuthoritative` 추가), FAIL 결과에는 `policyCheck` 없음. 원장 읽기 3초 타임아웃·재시도 없음, 발급기관 캐시 5초 이하
- 발급기관: 폐기는 원장 게시 실패 시 503(`LEDGER_PUBLISH_FAILED`)과 다음 게시 때 병합(`POST /admin/status-list/resync`), 번들·버전 단위 일괄 폐기(`revoke-by-bundle`), 유효기간 = min(발급 + 365일, 고시 연도 말), 발급 입력 검증(`CLAIMS_INVALID`·`STATUS_LIST_FULL`), 동의 영수증 앵커 비동기화, `/.well-known/issuer` 에 `bundle.evalDate`
- 시연: 확인 숫자 4자리(`confirmCode`, 지갑·창구 화면 대조), 지갑은 제출 시간 초과 시 VP 해시로 결과 폴링. 만료 공격이 원래 요청 상태를 바꾸지 않고 위조·타인 공격은 사유 코드 하나로 결정. AI 채팅 마스킹·세션 30분·'자격 판정이 아님' 안내
- 문서: DEMO(⑤ 폐기 → ⑦ 발급기관 정지 순서, ⑦ 뒤 재기동 명령, 체크리스트 11개, 확인 숫자, 예상 질의 '남는 기록'·대리 제출·식별자·390건·검증 시간·PII 스캔·결과 조회), 스토리보드 장면 순서, ARCHITECTURE('읽기만' → 제출 영수증 앵커, 원장 기록/비기록 표, 결과 조회 보호), README(보안·실행 메모), DECISIONS(D-23 추가, D-12·D-19 날짜 주석), PLAN·PROPOSAL_DELTA. 발표자료(제안요약서·전체정리·멘토링 문서) 정정 목록은 `../발표자료_정정사항_2026-10-09.txt`
- 남은 것: E2E 재실행 → `docs/TEST_REPORT.md`·`docs/DEMO_RUN.md`·스크린샷 재생성(체크리스트 11개·확인 숫자·영수증 표시가 바뀐 화면), 벤치 재측정(캐시 TTL 단축 반영)
