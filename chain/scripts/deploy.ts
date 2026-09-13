// 4개 컨트랙트를 배포하고 chain/deployments/<network>.json 과 latest.json 에 주소·ABI 를 기록한다.
//   pnpm deploy:localhost   (hardhat node)      pnpm deploy:besu   (RPC_URL, chainId 1337)
// RuleRegistry / StatusListRegistry 는 IssuerRegistry 주소를 생성자에 받아 권한 검사를 위임한다.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { artifacts, network } from "hardhat";
import { getAddress } from "viem";

const DEPLOYMENTS_DIR = fileURLToPath(new URL("../deployments/", import.meta.url));
const CONTRACTS = ["IssuerRegistry", "RuleRegistry", "StatusListRegistry", "ReceiptAnchor"] as const;

/** http 네트워크의 url 은 설정 변수(SensitiveString)로 지연 해석될 수 있다. */
async function resolveRpcUrl(cfg: { type: string; url?: unknown }): Promise<string> {
  if (cfg.type !== "http") return "in-process (edr-simulated)";
  const u = cfg.url as string | { get(): Promise<string> } | { getUrl(): Promise<string> };
  if (typeof u === "string") return u;
  if ("getUrl" in u) return u.getUrl();
  return u.get();
}

const { viem, networkName, networkConfig } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const rpcUrl = await resolveRpcUrl(networkConfig);
// gasPrice 를 고정한 네트워크(besu: 0)는 레거시 gasPrice 를 명시해 EIP-1559 수수료 추정을 건너뛴다
const fee = typeof networkConfig.gasPrice === "bigint" ? { gasPrice: networkConfig.gasPrice } : {};

console.log(`[deploy] network=${networkName} chainId=${chainId} rpc=${rpcUrl}`);
console.log(`[deploy] deployer(governance)=${getAddress(deployer.account.address)}`);

const issuerRegistry = await viem.deployContract("IssuerRegistry", [], fee);
const ruleRegistry = await viem.deployContract("RuleRegistry", [issuerRegistry.address], fee);
const statusListRegistry = await viem.deployContract("StatusListRegistry", [issuerRegistry.address], fee);
const receiptAnchor = await viem.deployContract("ReceiptAnchor", [], fee);

// 체크섬 주소로 기록 (viem 지갑은 소문자를 돌려준다)
const addresses = {
  IssuerRegistry: getAddress(issuerRegistry.address),
  RuleRegistry: getAddress(ruleRegistry.address),
  StatusListRegistry: getAddress(statusListRegistry.address),
  ReceiptAnchor: getAddress(receiptAnchor.address),
} as const;

const contracts: Record<string, { address: string; abi: unknown }> = {};
for (const name of CONTRACTS) {
  const { abi } = await artifacts.readArtifact(name);
  contracts[name] = { address: addresses[name], abi };
  console.log(`  ${name.padEnd(19)} ${addresses[name]}`);
}

const deployment = {
  network: networkName,
  chainId,
  rpcUrl,
  deployedAt: new Date().toISOString(),
  deployer: getAddress(deployer.account.address),
  contracts,
};

await mkdir(DEPLOYMENTS_DIR, { recursive: true });
const json = `${JSON.stringify(deployment, null, 2)}\n`;
const target = `${DEPLOYMENTS_DIR}${networkName}.json`;
await writeFile(target, json);
await writeFile(`${DEPLOYMENTS_DIR}latest.json`, json);
console.log(`[deploy] wrote ${target}`);
console.log(`[deploy] wrote ${DEPLOYMENTS_DIR}latest.json (복사본 — 서비스/패키지는 이 파일을 읽는다)`);
