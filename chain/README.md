# @dbp/chain — 스마트 컨트랙트 · 배포 · 시드 · PII 스캔 · Besu

Hardhat **3.16** (ESM, `node:test` 러너, viem) + Solidity **0.8.28** (`evmVersion: paris`, optimizer 200).
원장에는 **개인정보가 올라가지 않는다** — 각 컨트랙트 상단 NatSpec 에 "저장하는 것 / 저장하지 않는 것" 을 명시했다.

## 컨트랙트 (`contracts/`)

| 컨트랙트 | 온체인 데이터 | 쓰기 권한 |
|---|---|---|
| `IssuerRegistry` | 발급기관 DID, Ed25519 공개키(32B), 기관명, 컨트롤러 EVM 주소, 활성 여부 | `register/setActive/rotateKey/transferGovernance` = governance(배포자) |
| `RuleRegistry` | (번들, 버전) → 번들 해시·스키마 해시·등록자·시각. **버전당 1회, 불변** | `registerBundle` = 활성 발급기관 컨트롤러 |
| `StatusListRegistry` | listId → gzip+base64url 비트열, 단조 증가 version, 소유자 | 첫 `publish` = 활성 발급기관(소유자 확정), 이후 = 소유자만, version 은 엄격 증가 |
| `ReceiptAnchor` | 솔트 포함 영수증 해시 → 앵커 시각 (kind 1=consent, 2=presentation) | 누구나, 같은 해시는 1회 |

revert 사유는 짧은 코드 문자열이라 서비스에서 그대로 매핑하면 된다:
`NOT_GOVERNANCE EMPTY_DID EMPTY_KEY ZERO_CONTROLLER ISSUER_EXISTS CONTROLLER_BOUND ISSUER_UNKNOWN ZERO_GOVERNANCE`
`ZERO_REGISTRY NOT_ACTIVE_ISSUER EMPTY_ID EMPTY_HASH BUNDLE_EXISTS BUNDLE_UNKNOWN`
`EMPTY_LIST NOT_LIST_OWNER VERSION_NOT_INCREASING LIST_UNKNOWN BAD_KIND ALREADY_ANCHORED`

## 명령 (`chain/` 에서)

| 명령 | 설명 |
|---|---|
| `pnpm compile` | solc 0.8.28 컴파일 → `artifacts/` |
| `pnpm test` | `test/*.test.ts` (node:test, 인프로세스 EDR, 테스트마다 새 체인) |
| `pnpm node` | Hardhat JSON-RPC 노드 (http://127.0.0.1:8545, chainId 31337) |
| `pnpm deploy:localhost` / `deploy:besu` | 4개 컨트랙트 배포 → `deployments/<network>.json` + `latest.json` |
| `pnpm seed:localhost` / `seed:besu` | `seed-input.json` 으로 발급기관 등록 → 규칙 번들 등록 → 빈 상태목록 게시 (멱등). **데모 시드는 루트의 `uv run python scripts/seed_ledger.py`** |
| `pnpm scan-pii` | 모든 블록·tx·로그를 `data/citizens.json` 기준으로 스캔해 PII 부재를 assert (발견 시 exit 1) |
| `pnpm besu:keys` | Besu 검증자 키·제네시스 생성 (`besu/README.md`) |

네트워크: `hardhat`(인프로세스) · `localhost`(127.0.0.1:8545, 31337) · `besu`(`RPC_URL`, 1337, gasPrice 0).
서명 키는 루트 `.env` 의 `GOVERNANCE_PRIVATE_KEY` / `ISSUER_EVM_PRIVATE_KEY` / `VERIFIER_EVM_PRIVATE_KEY`, 없으면 Hardhat 기본 계정 #0/#1/#2.

## `deployments/` 처리 규칙

- `deploy` 는 `deployments/<network>.json` 을 쓰고 **같은 내용을 `deployments/latest.json` 으로 복사**한다.
  형식: `{ network, chainId, rpcUrl, deployedAt, deployer, contracts: { <Name>: { address, abi } } }`
- `services/*` 와 `packages/ledger-client` 는 **`latest.json` 만 읽는다** → localhost ↔ besu 전환은 배포만 다시 하면 된다.
- `localhost.json` 은 gitignore(루트 `.gitignore`), `latest.json` 은 커밋 대상 — "현재 데모가 가리키는 배포". 
  Hardhat node 는 배포 nonce 가 고정이라 주소가 항상 같다(IssuerRegistry `0x5FbDB2315678afecb367f032d93F642f64180aa3` …); 노드를 재시작하면 `deploy` 를 다시 실행해야 상태가 생긴다.
- `seed` 는 `deployments/<network>.json` 의 chainId 를 RPC 와 대조하고 다르면 중단한다.

## 서비스 쪽 원장 클라이언트 (`packages/ledger-client/py`)

- 읽기 RPC 는 요청당 **3초 타임아웃, 재시도 없음**(web3 기본 재시도 5회를 끈다). 멈춘 원장에서 조회 하나가 약 52초 걸리던 문제를 막는다.
- 전송 오류·타임아웃·노드 오류는 `LedgerUnavailable`(원장 장애)로, 컨트랙트 revert(`ISSUER_UNKNOWN`·`LIST_UNKNOWN`·`BUNDLE_UNKNOWN`)는
  web3 `ContractLogicError` 그대로("등록되지 않음") 올린다 — 검증기관이 장애를 '미등록 발급기관'·'위조'로 잘못 분류하지 않게 하기 위해서다.
- 캐시: 발급기관 레코드 **최대 5초**(정지·키 교체가 5초 안에 반영), 상태목록 **캐시 없음**(설정해도 최대 2초), 규칙 번들 60초(버전당 1회 등록·불변).
  실패한 조회는 캐시하지 않는다.
- 쓰기: 같은 RPC·같은 계정의 tx 는 프로세스 안에서 락으로 직렬화해 nonce 조회 → 서명 → 전송을 하나씩 한다(동시 폐기 시 `nonce too low` 방지).
- 조회 결과에 대조용 주소가 들어 있다: `get_issuer()["controller"]`(기관의 EVM 주소), `get_status_list()["owner"]`(목록 게시자).
- 알려진 한계: `rotateKey` 는 키 이력 없이 덮어쓰므로 교체 전에 발급한 VC 는 교체 후 서명 검증에 실패한다(kid 별 키 이력은 컨트랙트 변경이 필요해 범위 밖).

## 시드 입력

`seed-input.json` (없으면 `seed-input.example.json`):

```json
{ "issuers": [{ "did", "name", "ed25519PubKeyHex", "controllerPrivateKey" }],
  "bundles": [{ "issuerDid", "bundle", "version", "bundleHash", "schemaHash" }],
  "statusLists": [{ "issuerDid", "listId", "encodedListBase64url", "version" }] }
```

예시의 공개키·해시는 자리표시자(`0xa1a1…` 같은 반복 바이트)다. 원장 등록은 되돌릴 수 없으므로 **`seed.ts` 는 자리표시자를 발견하면
tx 를 하나도 보내지 않고 중단한다.** 데모(localhost·Besu 모두)는 실제 공개키·번들 해시를 직접 계산하는
`uv run python scripts/seed_ledger.py`(저장소 루트, `RPC_URL` 인식)로 시드한다. `seed.ts` 를 쓰려면 실제 값을 `packages/vc`(Ed25519 시드 → 공개키)와
`packages/rules`(`sha256(JCS(bundle))`)로 만들어 `seed-input.json` 으로 넣는다. 이미 등록된 발급기관·번들은 원장 값(공개키·컨트롤러,
번들·스키마 해시)이 입력과 같을 때만 skip 하고, 다르면 차이를 출력하고 exit 2 로 끝난다.
`encodedListBase64url` 이 빈 문자열이면 131,072비트 빈 목록을 스크립트가 gzip+base64url 로 계산한다.

## PII 스캔

`scripts/scan-pii.ts` 는 Hardhat `run` 태스크가 인자를 전달하지 못해 **plain Node**(Node 22.18+/26 의 네이티브 TS)로 실행한다.
`pnpm scan-pii [-- --rpc URL] [--citizens 경로] [--names 추가이름,…] [--dids did:key:…] [--from N] [--to N|latest]`

탐지 목록은 기본으로 **`data/citizens.json`(합성 시민 30명)에서 만든다** — `--names` 는 추가분이다.

| 대상 | 어디서 | 규칙 |
|---|---|---|
| 시민 이름 30개, citizenId(`C-001`…), 생년월일 값 | calldata·로그 data 를 UTF-8 로 손실 허용 디코딩한 문자열 | 정확히 일치 |
| 소득 값(`monthlyIncomeKRW`·`annualIncomeKRW`, 1만 원 이상) — 10진 문자열 | 위와 같음 | 앞뒤가 숫자가 아닌 일치 |
| 소득 값 — **32바이트 big-endian 정수(ABI `uint256`)** | calldata·로그 data·로그 topics[1..] 원시 바이트 | 바이트 경계 어디든 |
| 주민번호 `\d{6}-?[1-4]\d{6}`, `monthlyIncomeKRW`/`annualIncomeKRW`/`birthDate` 리터럴, JWT(`eyJ…`+`.`) | 문자열 | 패턴 |
| 시민 지갑 DID `did:key:z…`, `--dids` 로 준 DID | 문자열 | 패턴·일치 (발급기관 DID `did:dbp:…` 는 공개 정보라 제외) |

시작 시 합성 값으로 규칙마다 자가 점검하고, `test/ScanPii.test.ts` 가 인프로세스 체인에서 "데모와 같은 쓰기만 있으면 0건",
"`bytes32` 칸에 연소득 정수·발급기관 이름 칸에 시민 이름을 넣으면 calldata·로그 양쪽에서 검출"을 확인한다.

**탐지하지 못하는 것(스캔 범위의 한계):** 해시·암호화·압축된 값(솔트 포함 영수증 해시가 원문을 드러내지 않는 것과 같은 이유),
32바이트가 아닌 정수 폭(`uint64` packed 등), 1만 미만 정수(ABI 오프셋·길이·버전과 겹친다), `citizens.json` 에 없는 사람의
이름·소득, 블록 헤더(`extraData`). 원장 상태를 바꾸는 쓰기는 모두 tx calldata 를 거치고 이벤트는 로그로 남으므로 calldata·로그가
스캔 대상이다. 즉 "0건"은 **이 규칙으로 찾을 수 있는 형태의 시민 데이터가 원장에 없다**는 뜻이다.
