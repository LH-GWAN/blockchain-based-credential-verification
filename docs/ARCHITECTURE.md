# 아키텍처

구조도(제안요약서 그림 1)의 ①~⑦ 흐름과 코드 경로를 대응시킨다.

| 흐름 | 설명 | 코드 |
|---|---|---|
| ① 규칙 정의 배포 | 발급기관이 자격 기준을 JSON Logic 번들로 코드화, 지갑이 동일 번들을 받아 단말 안에서 사전 판정 | `packages/rules/bundles/daegu-eligibility/2026.2/`, 지갑 `GET /rules/bundles/…`, `@dbp/rules evaluateClaims` |
| ② 공개키·스키마·규칙 버전 등록 | 거버넌스가 발급기관 공개키 등록, 발급기관 컨트롤러가 번들 해시 등록, 빈 상태목록 게시 | `scripts/seed_ledger.py`, `chain/contracts/IssuerRegistry.sol`, `RuleRegistry.sol`, `StatusListRegistry.sol` |
| ③ 자격 VC 발급 요청 | 홀더 키로 챌린지 서명(키 보유 증명) + 동의 범위 명시 | 지갑 `/credentials`, `services/issuer` `POST /credentials/challenge`, `/credentials/issue` |
| ④ 원자적 VC 발급 | 공공 발급기관(대구광역시: 주민등록·가구 사실 / 사회보장정보원(복지기관): 수급·소득구간·연소득 사실)이 자기 소관 claim 만 동일 규칙 버전으로 판정 → 원장 해시 대조 → true 인 사실마다 VC-JWT(EdDSA) 1장 → 동의 영수증 해시 앵커. 신용평점(`issuerOf: self`)은 발급하지 않는다 — 창구가 자체 조회 | `services/issuer/src/dbp_issuer/service.py`, `@dbp/vc issue_vc` |
| ⑤ 검증 요청 QR | 은행·저축은행 창구가 용도 프리셋 6종(서민금융 상담 / 햇살론 일반보증 / 햇살론 일반보증 · 신용 하위 20% 고객 / 새희망홀씨 / 새희망홀씨 · 신용 하위 20% 고객 / 공공요금 감면)으로 요청 항목 + 1회용 확인번호(nonce, 120초) + 6자리 코드. 프리셋마다 취급 창구 종류(`verifierKinds`)가 있어 새희망홀씨는 은행만 제공하고, 취급하지 않는 창구의 요청은 `PRESET_NOT_OFFERED`(HTTP 400)로 거절한다. 신용 하위 20% 고객용 프리셋은 창구가 먼저 조회한 신용평점을 `counterChecked` 로 들고 있다(증명서로 받지 않음) | `services/verifier` `POST /requests`, 검증기관 앱 `/` |
| ⑥ 서명 제출(VP) | 요청된 claim 의 VC 만 골라 홀더 키로 VP-JWT 서명 (원자적 VC = 선택적 공개) | 지갑 `/present`, `@dbp/vc createVp` |
| ⑦ 발급기관·폐기 상태 조회 | 검증기관은 원장에서 공개키·상태목록·번들 해시만 읽는다. 발급기관 서버에 접속하지 않는다 | `services/verifier/src/dbp_verifier/verify.py`, `packages/ledger-client` |

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
     │  ⑦ 읽기만
[검증기관]   은행·저축은행 창구 · nonce 저장소 · 검증 결과            ── 받는 것: 참/거짓 + 발급기관 + 유효상태 (소득금액증명 원본 아님)
     ▲
     │  ⑥ VP-JWT
[시민 단말]
```

- **정책 채널**: `data/policies/*.json` 의 `channel` (welfare·transport = 복지멤버십 안내 대상 공공 제도 / finance·discount = 복지멤버십에 없는 은행 서민금융·민간 감면). 지갑과 AI 는 finance·discount 를 먼저, 자세히 다룬다.
- **AI 서비스**는 별도 프로세스이며 규칙 엔진이 만든 범주값(연령대·가구원수·소득구간·거주·수급·신용구간)과 정책 문서만 받는다. 원장·발급기관에 접근하지 않는다. `CategoricalProfile(extra="forbid")` 가 방화벽 역할을 한다.
- **docker-compose** 네트워크: `net-citizen`(지갑↔서비스), `net-issuer`(발급기관↔체인), `net-verifier`(검증기관↔체인). 검증기관은 `net-issuer` 에 없다.

## 데이터 모델 요약

- 규칙 번들 = `{bundle, version, preprocess, claims, policies, tables}`; 해시 = SHA-256(JCS(번들)). 정수 연산만 사용. 현재 `daegu-eligibility@2026.2`, 해시 `0xb24ad5f2…d94e` (원장의 (번들, 버전) 항목은 불변이라 규칙을 바꾸면 버전을 올려 새로 등록한다, D-03·D-21. 2026.2 는 지속 원장에 등록된 적이 없어 D-22 정정을 같은 버전에 합쳤다).
- 기준 중위소득표는 1~6인 고시값(제2025-135호)만 담는다. 7인 이상 가구는 전처리가 6인으로 잘라 판정한다(MVP 한계, D-22).
- 정책 문서(`data/policies/*.json`) = 설명·근거 조항(`legalBasis`)·`channel`·`verifierHint` + `requiredClaimSets`: 규칙식의 OR 분기마다 증명 조합을 하나씩 둔 anyOf 목록(`RequiredClaim[][]`, 각 조합은 AND). 앞 조합이 우선 안내 경로이고, 조합에는 창구가 직접 확인하는 `issuerOf: "self"` 항목(신용평점)과 `expected: false` 항목(차상위의 '수급자 아님')도 들어 있다. 읽기는 Python `claim_sets` / TS `claimSetsOf`(옛 `requiredClaims` 단일 목록도 조합 하나로 읽는다).
- 검증 결과의 정책 판정 재현 `policyCheck = {policyId, eligible: true|false|null, pending: [{claim, label}], counterChecked: [{claim, expected, label}]}`. (창구 확인값 ∪ 검증된 VC claim)만으로 `evaluate_policy_partial` 이 판정하며, 제출되지 않은 항목을 거짓으로 채우지 않는다. 결과가 미제출 항목에 달려 있으면 `eligible: null` 과 그 항목(`pending`)을 돌려준다.
- 원자적 VC: `credentialSubject = { id: holderDid, <claim>: true }` 하나. `credentialStatus` = Bitstring Status List 항목(무작위 인덱스). `evidence` = 번들·버전·해시.
- VP: `{ iss: holderDid, aud: verifierDid, nonce, vp.verifiableCredential: [요청된 VC 만] }`.
- 영수증: `sha256(JCS({kind, …, salt}))` 만 원장에. 원문+솔트는 홀더 보관 → 사후 대조 가능, 사전 대입 불가.

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
