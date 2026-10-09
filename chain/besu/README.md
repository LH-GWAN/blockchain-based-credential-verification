# Besu QBFT 4-validator 로컬 네트워크

> **검증 완료 (2026-09-14, macOS arm64, Docker 29.6)** — 4 validator 모두 healthy, 2초 블록 생성,
> 컨트랙트 배포·시드·발급(0.7초, 블록 대기 포함)·검증(28ms)·폐기 차단·PII 스캔(44블록, findings=0)까지 확인했다.
> 호스트 포트는 `BESU_RPC_PORT` 로 바꿀 수 있다 (기본 8545; Hardhat 과 동시에 띄우려면 `BESU_RPC_PORT=8546`).
> 이후 변경(2026-10-09): 프리펀딩 주소 3개(#2·#3·#5) 오기를 고쳐 `genesis.json` 을 다시 생성했고, RPC 를 루프백에만 열도록 좁혔다.
> 제네시스가 바뀌었으므로 **이전에 띄운 적이 있으면 `docker compose down && rm -rf data` 후 재기동**해야 한다(제네시스 해시 불일치).

- 이미지: `hyperledger/besu:latest` (arm64 지원), `platform: linux/arm64` 명시
- chainId **1337**, 블록 주기 2초, `--min-gas-price=0` + 제네시스 `zeroBaseFee: true` → 가스비 0
- RPC: validator1 만 호스트 **127.0.0.1:8545** 로 노출 (`ETH,NET,WEB3,QBFT,TXPOOL`). 같은 LAN 에서는 닿지 않는다.
  거버넌스 키가 공개 테스트 키(Hardhat #0)라 RPC 가 열려 있으면 누구나 `rotateKey` 로 발급키를 바꿀 수 있기 때문이다.
  `--host-allowlist=localhost,127.0.0.1`, CORS 는 로컬 앱 출처(`localhost`·`127.0.0.1` 의 3000·3001·3010·3011)만 허용.
- 프리펀딩: Hardhat 기본 계정 #0 ~ #5 (각 10,000 ETH) — 주소는 `gen-keys.ts` 가 Hardhat 테스트 니모닉에서 계산한다
  (#0 거버넌스, #1 대구시, #2 복지기관, #3 검증기관). 서비스는 `RPC_URL` 만 바꾸면 그대로 동작
- 피어링: discovery 끄고 고정 IP(172.16.239.11 ~ .14) `static-nodes.json` 사용

## 키에 대한 경고 (로컬 데모 전용)

`keys/validatorN/key` 는 `keccak256("dbp-besu-local-demo-validator-N")` 로 만든 **누구나 재현 가능한 키**다.
외부에 노출되는 네트워크에서는 절대 사용하지 말고, `./gen-keys.sh --docker` 로 무작위 키를 새로 만들어라.

## 명령

```bash
cd chain
pnpm besu:keys                      # keys/, genesis.json, static-nodes.json 생성(결정론적, 재실행해도 동일)
cd besu
docker compose up -d                # 4 validator 기동  (BESU_RPC_PORT=8546 docker compose up -d 로 포트 변경 가능)
docker compose logs -f validator1   # 블록 생성 로그 확인 (Ctrl+C)

# 검증자 4명 확인
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  http://127.0.0.1:8545

cd ..                               # → chain/
# 컨트랙트 배포 → deployments/besu.json + latest.json
RPC_URL=http://127.0.0.1:8545 pnpm deploy:besu
# 시드 (저장소 루트에서 실행) — 실제 Ed25519 공개키·규칙 번들 해시를 계산해 등록한다
#   ※ pnpm seed:besu 는 seed-input.json 을 손으로 채운 경우에만 쓴다(예시의 자리표시자 값은 등록을 거부한다)
(cd .. && RPC_URL=http://127.0.0.1:8545 uv run python scripts/seed_ledger.py)
# PII 스캔 — data/citizens.json 기준
RPC_URL=http://127.0.0.1:8545 pnpm scan-pii

cd besu
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
