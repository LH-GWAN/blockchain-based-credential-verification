# 아키텍처

구조도(제안요약서 그림 1)의 ①~⑦ 흐름과 코드 경로를 대응시킨다.

| 흐름 | 설명 | 코드 |
|---|---|---|
| ① 규칙 정의 배포 | 발급기관이 자격 기준을 JSON Logic 번들로 코드화, 지갑이 동일 번들을 받아 단말 안에서 사전 판정 | `packages/rules/bundles/daegu-eligibility/2026.2/`, 지갑 `GET /rules/bundles/…`, `@dbp/rules evaluateClaims` |
| ② 공개키·스키마·규칙 버전 등록 | 거버넌스가 발급기관 공개키 등록, 발급기관 컨트롤러가 번들 해시 등록, 빈 상태목록 게시 | `scripts/seed_ledger.py`, `chain/contracts/IssuerRegistry.sol`, `RuleRegistry.sol`, `StatusListRegistry.sol` |
| ③ 자격 VC 발급 요청 | 홀더 키로 챌린지 서명(키 보유 증명) + 동의 범위 명시 | 지갑 `/credentials`, `services/issuer` `POST /credentials/challenge`, `/credentials/issue` |
| ④ 원자적 VC 발급 | 공공 발급기관(대구광역시: 주민등록·가구 사실 / 사회보장정보원(복지기관): 수급·소득구간·연소득 사실)이 자기 소관 claim 만 동일 규칙 버전으로 판정 → 원장 해시 대조 → true 인 사실마다 VC-JWT(EdDSA) 1장 → 동의 영수증 해시 앵커. 신용평점(`issuerOf: self`)은 발급하지 않는다 — 창구가 자체 조회 | `services/issuer/src/dbp_issuer/service.py`, `@dbp/vc issue_vc` |
| ⑤ 검증 요청 QR | 은행·저축은행 창구가 용도 프리셋 6종(서민금융 상담 / 햇살론 일반보증 / 햇살론 일반보증 · 신용 하위 20% 고객 / 새희망홀씨 / 새희망홀씨 · 신용 하위 20% 고객 / 공공요금 감면)으로 요청 항목 + 1회용 확인번호(nonce, 120초) + 6자리 코드. 요청 항목이 비었거나 중복이거나 발급기관 소관이 아닌 항목(`issuerOf` 가 없거나 `self`)이면 `REQUESTED_INVALID`(HTTP 400). 응답의 창구 토큰(`counterToken`)은 QR·6자리 코드 조회에 들어가지 않고 요청을 만든 창구 화면만 가진다(결과 조회용). 프리셋마다 취급 창구 종류(`verifierKinds`)가 있어 새희망홀씨는 은행만 제공하고, 취급하지 않는 창구의 요청은 `PRESET_NOT_OFFERED`(HTTP 400)로 거절한다. 신용 하위 20% 고객용 프리셋은 창구가 먼저 조회한 신용평점을 `counterChecked` 로 들고 있다(증명서로 받지 않음) | `services/verifier` `POST /requests`, 검증기관 앱 `/` |
| ⑥ 서명 제출(VP) | 요청된 claim 의 VC 만 골라 홀더 키로 VP-JWT 서명 (원자적 VC = 선택적 공개). 지갑은 VP 에서 확인 숫자 4자리(`sha256(vpJwt)` 앞 8자리 → 10진 mod 10000)를 계산해 보여 주고, 창구 화면도 같은 숫자를 보여 직원이 대조한다. 제출 응답이 끊기면 다시 제출하지 않고 VP 해시(`X-Vp-Hash`)로 결과를 조회한다 | 지갑 `/present`, `@dbp/vc createVp` |
| ⑦ 발급기관·폐기 상태 조회 + 제출 영수증 앵커 | 검증기관은 원장에서 공개키·발급기관 활성 여부·상태목록(게시자)·번들 해시를 읽고, 제출 1건마다 제출 영수증의 솔트 해시를 `ReceiptAnchor.anchor(h, kind=2)` 로 원장에 남긴다(검증기관 주소·시각이 함께 공개된다). 발급기관 서버에는 접속하지 않는다. 검증 순서: VP 파싱 → VP 서명 → aud → nonce 소모(서명·aud 가 맞는 VP 만 소모) → VC 별 발급기관·서명·유효기간·폐기·규칙 버전·소유자·발급 권한 → 요청 항목 충족 | `services/verifier/src/dbp_verifier/verify.py`, `packages/ledger-client`, `chain/contracts/ReceiptAnchor.sol` |

## 신뢰 경계

```
[시민 단말]  원본 프로필 · 홀더 키 · VC · 영수증 원문+솔트          ── 개인정보가 머무는 곳
     │  ③ claim 이름 + DID + 챌린지 서명 + 동의              (원본 수치 없음)
     ▼
[발급기관]   원본 심사자료(자기 소관 필드만) · Ed25519 서명키       ── 개인정보가 머무는 곳
     │  ② 공개키 · 번들 해시 · 상태목록 · 영수증 해시            (개인정보 없음)
     ▼
[공동원장]   IssuerRegistry · RuleRegistry · StatusListRegistry · ReceiptAnchor
     ▲
     │  ⑦ 읽기 (공개키·상태목록·번들 해시) + 제출 영수증 솔트 해시 앵커 1건/제출 (검증기관 주소·시각 공개)
[검증기관]   은행·저축은행 창구 · nonce 저장소 · 검증 결과            ── 받는 것: 참/거짓 + 증명서 메타데이터(발급기관·지갑 DID·증명서 ID·유효기간) (소득금액증명 원본 아님)
     ▲
     │  ⑥ VP-JWT
[시민 단말]
```

- **정책 채널**: `data/policies/*.json` 의 `channel` (welfare·transport = 복지멤버십 안내 대상 공공 제도 / finance·discount = 복지멤버십에 없는 은행 서민금융·민간 감면). 지갑과 AI 는 finance·discount 를 먼저, 자세히 다룬다.
- **AI 서비스**는 별도 프로세스이며 규칙 엔진이 만든 범주값(연령대·가구원수·소득구간·거주·수급·신용구간)과 정책 문서만 받는다. 원장·발급기관에 접근하지 않는다. `CategoricalProfile(extra="forbid")` 가 방화벽 역할을 한다. 채팅 자유입력은 시민이 직접 쓰는 글이라 주민등록번호·전화번호·계좌형 숫자·금액을 LLM 과 세션 저장소에 넘기기 전에 `[가림]` 으로 바꾸고, 세션은 30분 뒤(최대 200개) 지운다. "AI가 받은 정보" 화면은 응답마다 받은 `auditId` 로 `GET /audit/{auditId}` 를 조회한다(10분 보관, 다른 사용자의 기록은 볼 수 없다). 채팅 답변은 `eligibilitySource: "rule-engine"` 과 "채팅 답변은 자격 판정이 아닙니다" 안내를 함께 돌려준다.
- **docker-compose** 네트워크: `net-citizen`(지갑↔서비스), `net-issuer`(발급기관↔체인), `net-verifier`(검증기관↔체인). 검증기관은 `net-issuer` 에 없다.

## 원장에 남는 것 / 남지 않는 것

| 남는 것 (공개) | 누가 쓰나 | 남지 않는 것 |
|---|---|---|
| 발급기관 DID·공개키·컨트롤러 주소·활성 여부 | 거버넌스 (`IssuerRegistry`) | 이름·주민등록번호·주소 |
| 규칙 번들 (번들, 버전) → 해시 | 발급기관 컨트롤러 (`RuleRegistry`) | 소득 금액·수급 내역 등 원본 수치 |
| 상태목록 비트열·버전·게시자 | 발급기관 컨트롤러 (`StatusListRegistry`) | 증명서(VC)·제출물(VP) 원문 |
| 동의 영수증 솔트 해시 + 발급기관 주소·시각 (kind=1) | 발급기관 (`ReceiptAnchor`) | 지갑 DID·검증기관 DID·nonce·청구 항목·솔트 |
| 제출 영수증 솔트 해시 + 검증기관 주소·시각 (kind=2) | 검증기관 (`ReceiptAnchor`) | AI 상담 내용 |

- 제출 1건마다 원장 트랜잭션 1건이 생긴다. 내용은 해시뿐이지만 "어느 창구 주소가 언제 제출을 받았는지"는 공개된다. 시민 수가 적은 시점에는 발급(kind=1)과 제출(kind=2) 시각을 맞춰 추정할 여지가 있다 — 실서비스 과제: 일괄 앵커, 창구별 앵커 주소 분리(D-23).
- PII 스캔(`chain/scripts/scan-pii.ts`)은 모든 블록의 calldata·이벤트 로그에서 `data/citizens.json` 의 시민 이름 30개·citizenId·생년월일·소득 값(10진 문자열과 32바이트 `uint256` 인코딩 모두), 주민등록번호 패턴, 소득/생년월일 필드명, JWT, 시민 지갑 DID(`did:key:`)를 찾는다(탐지 범위 표: `chain/README.md` 'PII 스캔'). 해시·압축된 값, 32바이트가 아닌 정수 폭, 1만 미만 정수, 목록에 없는 사람의 값, 블록 헤더는 찾지 못한다. 그래서 "원장 개인정보 0건"은 이 탐지 범위의 결과이고, 그 밖의 형태로도 오르지 않는다는 근거는 원장에 쓰는 경로가 위 표의 항목뿐이라는 구조(`packages/ledger-client`)다.

## 결과 조회 보호 · 관리 API

- 6자리 코드 조회(`GET /requests/{code}`)는 요청 내용만 돌려주고, 만료·사용된 코드는 404(`REQUEST_UNKNOWN`), 같은 IP 의 실패 조회가 60초에 20회를 넘으면 429(`TOO_MANY_LOOKUPS`). 코드→요청 연결은 nonce 가 소모되거나 만료되면 지운다.
- 결과 조회(`GET /results/{id}`)는 창구 토큰(`X-Counter-Token`, 요청을 만든 창구 화면이 `sessionStorage` 에 보관) 또는 그 VP 를 낸 지갑의 VP 해시(`X-Vp-Hash`)가 있어야 한다. 없으면 401, 틀리면 403. 다른 사람이 보낸 실패 제출은 원래 요청의 결과 자리(`results[rid]`)를 차지하지 못하고 `rid#rejected-…` 로 따로 저장되며, 창구 화면에는 "다른 제출 시도 n건"(`otherAttempts`)으로만 보인다.
- 발급기관 관리 API(`/admin/*`)는 `ADMIN_TOKEN` 이 있으면 `X-Admin-Token` 헤더를 요구하고, 없으면 로컬 접속(127.0.0.1·::1)만 허용한다. 서비스는 기본으로 127.0.0.1 에만 바인딩한다(`HOST`, compose 는 0.0.0.0). CORS 허용 출처는 `ALLOWED_ORIGINS`.
- 폐기는 원장 게시까지 성공해야 성공으로 응답한다. 게시에 실패하면 503(`LEDGER_PUBLISH_FAILED`)이고, 로컬에는 폐기로 남긴 채 다음 게시(다음 폐기·`POST /admin/status-list/resync`·재기동) 때 원장 비트와 합쳐 다시 게시한다.

## 데이터 모델 요약

- 규칙 번들 = `{bundle, version, preprocess, claims, policies, tables}`; 해시 = SHA-256(JCS(번들)). 정수 연산만 사용. 현재 `daegu-eligibility@2026.2`, 해시 `0xa054a6a2…df60` (원장의 (번들, 버전) 항목은 불변이라 규칙을 바꾸면 버전을 올려 새로 등록한다, D-03·D-21. 2026.2 는 지속 원장에 등록된 적이 없어 D-22 정정을 같은 버전에 합쳤다).
- 기준 중위소득표는 1~6인 고시값(제2025-135호)만 담는다. 7인 이상 가구는 전처리가 6인으로 잘라 판정한다(MVP 한계, D-22).
- 정책 문서(`data/policies/*.json`) = 설명·근거 조항(`legalBasis`)·`channel`·`verifierHint` + `requiredClaimSets`: 규칙식의 OR 분기마다 증명 조합을 하나씩 둔 anyOf 목록(`RequiredClaim[][]`, 각 조합은 AND). 앞 조합이 우선 안내 경로이고, 조합에는 창구가 직접 확인하는 `issuerOf: "self"` 항목(신용평점)과 `expected: false` 항목(차상위의 '수급자 아님')도 들어 있다. 읽기는 Python `claim_sets` / TS `claimSetsOf`(옛 `requiredClaims` 단일 목록도 조합 하나로 읽는다).
- 검증 결과의 정책 판정 재현 `policyCheck = {policyId, eligible: true|false|null, pending: [{claim, label}], counterChecked: [{claim, expected, label}]}`. (창구 확인값 ∪ 검증된 VC claim)만으로 `evaluate_policy_partial` 이 판정하며, 제출되지 않은 항목을 거짓으로 채우지 않는다. 결과가 미제출 항목에 달려 있으면 `eligible: null` 과 그 항목(`pending`)을 돌려준다.
- 원자적 VC: `credentialSubject = { id: holderDid, <claim>: true }` 하나. `credentialStatus` = Bitstring Status List 항목(무작위 인덱스). `evidence` = 번들·버전·해시. `validUntil` = min(발급일 + 365일, 번들 `tables.medianIncomeYear` 연도 말 KST(`<연도>-12-31T14:59:59Z`)) — 기준 중위소득 고시가 바뀌는 해를 넘겨 쓰지 않는다. 검증기관은 받는 (번들, 버전) 목록(`ACCEPTED_BUNDLES`, 기본 `daegu-eligibility@2026.2`)에 없는 증명서를 `RULE_VERSION_NOT_ACCEPTED` 로 거절한다.
- VP: `{ iss: holderDid, aud: verifierDid, nonce, vp.verifiableCredential: [요청된 VC 만] }`. 요청하지 않은 claim 의 VC 가 섞이면 `UNREQUESTED_CREDENTIAL`(FAIL), VC 발급기관이 규칙 번들 `claims.issuerOf[claim]` 과 다르면 `ISSUER_NOT_AUTHORITATIVE`.
- 검증 결과 `checks` 는 항상 11개: `nonce`·`vpSignature`·`issuerOnLedger`·`issuerActive`·`issuerAuthoritative`·`vcSignature`·`notExpired`·`notRevoked`·`ruleVersion`·`holderBinding`·`requestedClaims`. 원장 연결 오류(타임아웃 등)는 `LEDGER_UNAVAILABLE` 로 따로 표시하고 '미등록 발급기관'·'위조'로 바꿔 부르지 않는다. FAIL 결과에는 `policyCheck` 가 없다. 결과에는 확인 숫자 `confirmCode` 와 같은 요청의 다른 제출 시도 수 `otherAttempts` 가 붙는다.
- 영수증: `sha256(JCS({kind, …, salt}))` 만 원장에. 동의 영수증(kind=1)은 발급기관이, 제출 영수증(kind=2)은 검증기관이 만들어 앵커하고 원문+솔트를 홀더에게 돌려준다. 솔트는 영수증을 만든 기관과 홀더만 알므로 사후 대조는 가능하고, 원장만 보는 제3자의 사전 대입은 불가능하다. `Anchored` 이벤트에는 앵커한 주소(`by`)와 시각(`ts`)이 남는다 — 어느 창구가 언제 제출을 받았는지는 원장에 공개되고, 누가 무엇을 냈는지는 남지 않는다.

## 표준 대응 (확장 경로)

| 본 MVP | 표준 | 전환 방법 |
|---|---|---|
| `POST /credentials/challenge` + `/issue` | OpenID4VCI (credential offer → token → credential) | 챌린지=`c_nonce`, issue=`credential` 엔드포인트로 매핑 |
| `POST /requests` QR + `POST /present` | OpenID4VP (presentation definition → VP token) | `requested[]` → presentation definition, `vpJwt` → `vp_token` |
| `did:dbp:<id>` 레지스트리 조회 | did:web / did:ethr | resolver 교체 |
| JWS(vc+jwt) | Data Integrity `eddsa-jcs-2022`, SD-JWT VC | 서명 모듈 교체, 검증 절차 동일 |
| 원자적 VC | 선택적 공개(BBS+) · 영지식 범위증명 | 로드맵 3단계 |

## 로드맵

1. 모사 발급기관 + 원자적 VC 로 전 과정 시연 (본 대회)
2. 모바일 신분증·마이데이터 연계 (`IssuerDataSource` 어댑터 교체)
3. 선택적 공개·영지식 범위증명
4. 대구시 → 타 지자체·은행권 발급기관 확대 (IssuerRegistry 거버넌스 다중서명)
5. 외국인·시각장애인 음성·다국어 인터페이스
