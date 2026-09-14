// 대구 혜택패스 — Hardhat 3 설정 (ESM + TypeScript + viem)
//
// 네트워크
//   hardhat   : 인프로세스 EDR 시뮬레이터 (테스트용, chainId 31337)
//   localhost : `hardhat node` (http://127.0.0.1:8545, chainId 31337)
//   besu      : Hyperledger Besu QBFT 4노드 (RPC_URL, chainId 1337, gasPrice 0)
//
// 서명 키는 루트 .env 의 GOVERNANCE_PRIVATE_KEY / ISSUER_EVM_PRIVATE_KEY /
// VERIFIER_EVM_PRIVATE_KEY 를 사용하고, 없으면 Hardhat 기본 계정 #0/#1/#2 로 폴백한다.
// (모두 공개된 테스트 키 — 로컬 데모 전용, 실서비스 사용 금지)
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";

loadDotenv({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

// Hardhat 기본 계정 (#0 governance, #1 issuer daegu, #2 imbank/verifier)
export const HARDHAT_DEFAULT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as const;

const accounts = [
  process.env.GOVERNANCE_PRIVATE_KEY || HARDHAT_DEFAULT_KEYS[0],
  process.env.ISSUER_EVM_PRIVATE_KEY || HARDHAT_DEFAULT_KEYS[1],
  process.env.VERIFIER_EVM_PRIVATE_KEY || HARDHAT_DEFAULT_KEYS[2],
];

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // PUSH0/MCOPY 등 최신 opcode 를 피해 어떤 Besu 제네시스에서도 실행되도록 고정
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: { type: "edr-simulated", chainId: 31337 },
    localhost: {
      // RPC_URL 로 덮어쓸 수 있다 (docker compose 에서는 http://chain:8545)
      type: "http",
      url: process.env.RPC_URL || "http://127.0.0.1:8545",
      chainId: 31337,
      accounts,
    },
    besu: {
      type: "http",
      url: process.env.RPC_URL || "http://127.0.0.1:8545",
      chainId: 1337,
      gasPrice: 0,
      accounts,
    },
  },
  paths: { tests: { nodejs: "test" } },
});
