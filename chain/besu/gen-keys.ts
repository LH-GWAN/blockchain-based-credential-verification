// Besu QBFT 4-validator 로컬 데모용 검증자 키 + 제네시스 + static-nodes 생성기 (결정론적, docker 불필요)
//   chain/ 에서:  pnpm besu:keys   또는   ./besu/gen-keys.sh
//   출력: besu/keys/validatorN/{key,key.pub,address}, besu/genesis.json, besu/static-nodes.json
//
// *** 경고: 검증자 개인키는 고정 문자열의 keccak256 이라 누구나 재현할 수 있다. ***
// *** 로컬 데모 전용이며 외부에 노출되는 네트워크에는 절대 사용하지 말 것.      ***
//
// 공식 Besu QBFT 튜토리얼과 같은 구조(`operator generate-blockchain-config` 산출물)를 재현하되
// docker 데몬이 없는 환경에서도 실행되도록 viem 으로 키·extraData(RLP)를 직접 계산한다.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { keccak256, stringToHex, toRlp } from "viem";
import type { Address, Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const OUT_DIR = fileURLToPath(new URL("./", import.meta.url));
const VALIDATORS = 4;
const CHAIN_ID = 1337;
const P2P_PORT = 30303;
const SUBNET_PREFIX = "172.16.239."; // docker-compose.yml 의 고정 IP(.11 ~ .14)와 일치해야 한다

// Hardhat 기본 계정 #0 ~ #5 — 각 10,000 ETH 프리펀딩 (gasPrice 0 이지만 잔액 검사 안전망)
// 주소를 손으로 적지 않고 Hardhat 공개 테스트 니모닉에서 계산한다(이전에 #2·#3·#5 주소 오기가 있었다).
// #0 거버넌스, #1 대구시 컨트롤러, #2 복지기관 컨트롤러, #3 검증기관(iM뱅크) — 모두 공개된 테스트 키.
const HARDHAT_TEST_MNEMONIC = "test test test test test test test test test test test junk";
const PREFUNDED: Address[] = Array.from(
  { length: 6 },
  (_, i) => mnemonicToAccount(HARDHAT_TEST_MNEMONIC, { addressIndex: i }).address,
);
const PREFUND_BALANCE = "0x21e19e0c9bab2400000"; // 10,000 ETH

const validators = Array.from({ length: VALIDATORS }, (_, i) => {
  const n = i + 1;
  const privateKey: Hex = keccak256(stringToHex(`dbp-besu-local-demo-validator-${n}`));
  const account = privateKeyToAccount(privateKey);
  const pub64 = account.publicKey.slice(4); // "0x04" 제거 → 64바이트 hex (enode id / key.pub 형식)
  return { n, privateKey, address: account.address, pub64, ip: `${SUBNET_PREFIX}${10 + n}` };
});

// QBFT extraData = RLP([32바이트 vanity, [validator 주소...], [] (votes), 0 (round), [] (committed seals)])
// `besu rlp encode --type=QBFT_EXTRA_DATA` 와 같은 결과를 낸다.
const extraData = toRlp([`0x${"00".repeat(32)}`, validators.map((v) => v.address), [], "0x", []]);

const genesis = {
  config: {
    chainId: CHAIN_ID,
    homesteadBlock: 0,
    eip150Block: 0,
    eip155Block: 0,
    eip158Block: 0,
    byzantiumBlock: 0,
    constantinopleBlock: 0,
    petersburgBlock: 0,
    istanbulBlock: 0,
    berlinBlock: 0,
    londonBlock: 0,
    zeroBaseFee: true, // London base fee 를 0 으로 고정 → --min-gas-price=0 과 함께 무료 트랜잭션
    qbft: {
      blockperiodseconds: 2,
      epochlength: 30000,
      requesttimeoutseconds: 4,
    },
  },
  nonce: "0x0",
  timestamp: "0x58ee40ba",
  gasLimit: "0x1fffffffffffff",
  difficulty: "0x1",
  mixHash: "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
  coinbase: "0x0000000000000000000000000000000000000000",
  baseFeePerGas: "0x0",
  alloc: Object.fromEntries(PREFUNDED.map((a) => [a, { balance: PREFUND_BALANCE }])),
  extraData,
};

const staticNodes = validators.map((v) => `enode://${v.pub64}@${v.ip}:${P2P_PORT}`);

for (const v of validators) {
  const dir = `${OUT_DIR}keys/validator${v.n}/`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}key`, `${v.privateKey}\n`);
  await writeFile(`${dir}key.pub`, `0x${v.pub64}\n`);
  await writeFile(`${dir}address`, `${v.address}\n`);
  console.log(`validator${v.n}  ${v.address}  ${v.ip}`);
}
await writeFile(`${OUT_DIR}genesis.json`, `${JSON.stringify(genesis, null, 2)}\n`);
await writeFile(`${OUT_DIR}static-nodes.json`, `${JSON.stringify(staticNodes, null, 2)}\n`);
console.log(`extraData ${extraData}`);
console.log(`wrote ${OUT_DIR}genesis.json, static-nodes.json, keys/validator1..${VALIDATORS}/`);
