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
| `pnpm seed:localhost` / `seed:besu` | 발급기관 2곳 등록 → 규칙 번들 등록 → 빈 상태목록 게시 (멱등) |
| `pnpm scan-pii -- --names 김복례,이순자` | 모든 블록·tx·로그를 스캔해 PII 부재를 assert (발견 시 exit 1) |
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

## 시드 입력

`seed-input.json` (없으면 `seed-input.example.json`):

```json
{ "issuers": [{ "did", "name", "ed25519PubKeyHex", "controllerPrivateKey" }],
  "bundles": [{ "issuerDid", "bundle", "version", "bundleHash", "schemaHash" }],
  "statusLists": [{ "issuerDid", "listId", "encodedListBase64url", "version" }] }
```

예시의 공개키·해시는 자리표시자다. 실제 값은 `packages/vc`(Ed25519 시드 → 공개키)와 `packages/rules`(`sha256(JCS(bundle))`)가 만들어 `seed-input.json` 으로 넣는다. `encodedListBase64url` 이 빈 문자열이면 131,072비트 빈 목록을 스크립트가 gzip+base64url 로 계산한다.

## PII 스캔

`scripts/scan-pii.ts` 는 Hardhat `run` 태스크가 인자를 전달하지 못해 **plain Node**(Node 22.18+/26 의 네이티브 TS)로 실행한다.
검사: `--names` 이름 목록, 주민번호 `\d{6}-?[1-4]\d{6}`, `monthlyIncomeKRW`/`annualIncomeKRW`/`birthDate`, JWT(`eyJ…`+`.`).
calldata 와 로그 data 를 UTF-8 로 손실 허용 디코딩해 검사하고(topics 는 keccak 해시), 시작 시 합성 문자열로 자가 점검한다.
