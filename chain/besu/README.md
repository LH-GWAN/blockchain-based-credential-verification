# Besu QBFT 4-validator 로컬 네트워크

> **UNTESTED** — 이 디렉터리는 작성 환경에 docker 데몬이 없어 실제 기동을 검증하지 못했다.
> 구조는 공식 Besu QBFT 튜토리얼(`operator generate-blockchain-config` 산출물)을 따르며,
> 첫 실행에서 문제가 있으면 `docs/DECISIONS.md` 에 사유를 적고 Hardhat node 폴백을 유지한다(§13 P1-1).

- 이미지: `hyperledger/besu:latest` (arm64 지원), `platform: linux/arm64` 명시
- chainId **1337**, 블록 주기 2초, `--min-gas-price=0` + 제네시스 `zeroBaseFee: true` → 가스비 0
- RPC: validator1 만 호스트 **8545** 로 노출 (`ETH,NET,WEB3,QBFT,TXPOOL`, CORS all, host-allowlist *)
- 프리펀딩: Hardhat 기본 계정 #0 ~ #5 (각 10,000 ETH) — 서비스는 `RPC_URL` 만 바꾸면 그대로 동작
- 피어링: discovery 끄고 고정 IP(172.16.239.11 ~ .14) `static-nodes.json` 사용

## 키에 대한 경고 (로컬 데모 전용)

`keys/validatorN/key` 는 `keccak256("dbp-besu-local-demo-validator-N")` 로 만든 **누구나 재현 가능한 키**다.
외부에 노출되는 네트워크에서는 절대 사용하지 말고, `./gen-keys.sh --docker` 로 무작위 키를 새로 만들어라.

## 명령

```bash
cd chain
pnpm besu:keys                      # keys/, genesis.json, static-nodes.json 생성(결정론적, 재실행해도 동일)
cd besu
docker compose up -d                # 4 validator 기동
docker compose logs -f validator1   # 블록 생성 로그 확인 (Ctrl+C)

# 검증자 4명 확인
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  http://127.0.0.1:8545

# 컨트랙트 배포 + 시드 (chain/ 에서)
RPC_URL=http://127.0.0.1:8545 pnpm deploy:besu
RPC_URL=http://127.0.0.1:8545 pnpm seed:besu
RPC_URL=http://127.0.0.1:8545 pnpm scan-pii -- --names 김복례

docker compose down                 # 중지 (체인 데이터 유지)
docker compose down && rm -rf data  # 중지 + 체인 초기화 (data/ 는 gitignore)
```

## 파일

| 파일 | 설명 |
|---|---|
| `docker-compose.yml` | validator1~4, 고정 IP 브리지 네트워크 |
| `gen-keys.ts` / `gen-keys.sh` | 키·제네시스·static-nodes 생성기 (`--docker` 로 공식 방식 대체 가능) |
| `config/qbftConfigFile.json` | `operator generate-blockchain-config` 입력 |
| `genesis.json` | QBFT 제네시스 (extraData = RLP[vanity, validators, [], 0, []]) |
| `static-nodes.json` | 4개 enode (고정 IP) |
| `keys/validatorN/` | `key`(개인키), `key.pub`, `address` |
| `data/` | 런타임 체인 데이터 (gitignore) |

## 알려진 주의점

- Docker Desktop(macOS)에서 `data/` 바인드 마운트 권한 문제가 나면 `docker compose down && rm -rf data` 후 재기동.
- `hyperledger/besu:latest` 가 바뀌어 플래그가 달라지면 `docker compose logs validator1` 의 첫 오류를 보고 조정.
- 컨트랙트는 `evmVersion: paris` 로 컴파일되어 London 제네시스에서 실행된다(PUSH0/MCOPY 미사용).
