// 시드 스크립트 — 발급기관 등록 → 규칙 번들 등록 → (빈) 상태목록 게시. 멱등: 이미 된 항목은 skip.
//   pnpm seed:localhost / pnpm seed:besu
//   입력: chain/seed-input.json (없으면 chain/seed-input.example.json)
//   데모 기본 경로는 이 스크립트가 아니라 `uv run python scripts/seed_ledger.py` 다 — 실제 Ed25519 공개키·번들 해시를
//   packages/vc·packages/rules 에서 직접 계산해 등록한다. 이 스크립트는 seed-input.json 을 손으로 채운 경우에만 쓴다.
//   자리표시자(0xa1a1… 같은 반복 바이트) 키·해시가 있으면 원장에 쓰기 전에 중단하고, 이미 등록된 항목은
//   원장 값이 입력과 같을 때만 skip 한다(다르면 중단).
//   배포 정보: chain/deployments/<network>.json (먼저 deploy:<network> 실행)
// 체인에 올라가는 것은 기관 DID·공개키·기관명·번들 해시·빈 비트열뿐이며 시민 데이터는 없다.
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { network } from "hardhat";
import { createWalletClient, custom, defineChain, getContract, isHex, stringToHex } from "viem";
import type { Abi, Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { diffRegistered, findPlaceholders } from "./seed-checks.js";
import type { SeedInput } from "./seed-checks.js";

interface Deployment {
  chainId: number;
  contracts: Record<"IssuerRegistry" | "RuleRegistry" | "StatusListRegistry", { address: Address; abi: Abi }>;
}

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const fileExists = (p: string) => access(p).then(() => true, () => false);

/** W3C Bitstring Status List v1.0: 최소 131,072비트(16 KiB) 전부 0 → gzip → base64url(패딩 없음). */
export function emptyStatusListBase64url(bits = 131072): string {
  return gzipSync(Buffer.alloc(bits / 8)).toString("base64url");
}

function to32(hex: string, label: string): Hex {
  const h = (hex.startsWith("0x") ? hex : `0x${hex}`).toLowerCase();
  if (!isHex(h) || h.length !== 66) throw new Error(`${label}: 32바이트 hex 가 아님 (${hex})`);
  return h as Hex;
}

// ---------------------------------------------------------------- 연결·입력 로드
const { viem, networkName, networkConfig, provider } = await network.getOrCreate();
const publicClient = await viem.getPublicClient();
const [governance] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const fee = typeof networkConfig.gasPrice === "bigint" ? { gasPrice: networkConfig.gasPrice } : {};

const deploymentPath = here(`../deployments/${networkName}.json`);
if (!(await fileExists(deploymentPath))) {
  throw new Error(`배포 파일이 없습니다: ${deploymentPath} — 먼저 deploy:${networkName} 를 실행하세요`);
}
const dep: Deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
if (dep.chainId !== chainId) throw new Error(`chainId 불일치: 배포 파일 ${dep.chainId} vs RPC ${chainId}`);

const inputPath = (await fileExists(here("../seed-input.json"))) ? here("../seed-input.json") : here("../seed-input.example.json");
const input: SeedInput = JSON.parse(await readFile(inputPath, "utf8"));
console.log(`[seed] network=${networkName} chainId=${chainId} governance=${governance.account.address}`);
console.log(`[seed] input=${inputPath}`);
const placeholders = findPlaceholders(input);
if (placeholders.length > 0) {
  throw new Error(
    `자리표시자 값이 있어 원장에 등록하지 않습니다 (${inputPath}):\n  ${placeholders.join("\n  ")}\n` +
      "실제 값으로 chain/seed-input.json 을 만들거나, 저장소 루트에서 `uv run python scripts/seed_ledger.py` 를 실행하세요.",
  );
}
const mismatches: string[] = [];

// ---------------------------------------------------------------- 지갑·컨트랙트
// governance 는 Hardhat 설정의 첫 계정. 발급기관 컨트롤러는 seed-input 의 개인키로 로컬 서명해 같은 provider 로 전송한다.
const chain = defineChain({
  id: chainId,
  name: networkName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});
const issuerRegistry = await viem.getContractAt("IssuerRegistry", dep.contracts.IssuerRegistry.address);

function controllerOf(privateKey: string) {
  const wallet = createWalletClient({ account: privateKeyToAccount(privateKey as Hex), chain, transport: custom(provider) });
  const bind = (name: "RuleRegistry" | "StatusListRegistry") =>
    getContract({ address: dep.contracts[name].address, abi: dep.contracts[name].abi, client: { public: publicClient, wallet } });
  return { address: wallet.account.address, ruleRegistry: bind("RuleRegistry"), statusListRegistry: bind("StatusListRegistry") };
}
const controllers = new Map(input.issuers.map((i) => [i.did, controllerOf(i.controllerPrivateKey)]));
const controllerFor = (did: string) => {
  const c = controllers.get(did);
  if (!c) throw new Error(`issuers 에 없는 issuerDid: ${did}`);
  return c;
};

let sent = 0;
let skipped = 0;
async function confirm(hash: Hex, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} 실패 tx=${hash}`);
  sent += 1;
  console.log(`  ✔ ${label}\n      tx=${hash}`);
}
function skip(label: string) {
  skipped += 1;
  console.log(`  · ${label} — skip`);
}

// ---------------------------------------------------------------- 1) 발급기관 등록 (governance)
console.log("[seed] 1/3 발급기관 등록");
for (const it of input.issuers) {
  const controller = controllerFor(it.did).address;
  if (await issuerRegistry.read.exists([it.did])) {
    const on = (await issuerRegistry.read.get([it.did])) as { ed25519PubKey: Hex; controller: Address };
    const diffs = diffRegistered(it.did, { ed25519PubKey: on.ed25519PubKey, controller: on.controller },
      { ed25519PubKey: it.ed25519PubKeyHex, controller });
    if (diffs.length > 0) mismatches.push(...diffs);
    skip(`${it.did} 이미 등록됨${diffs.length > 0 ? " (값 불일치!)" : " (값 일치)"}`);
    continue;
  }
  const hash = await issuerRegistry.write.register([it.did, to32(it.ed25519PubKeyHex, it.did), it.name, controller], fee);
  await confirm(hash, `register ${it.did} (${it.name}, controller=${controller})`);
}

// ---------------------------------------------------------------- 2) 규칙 번들 등록 (각 발급기관 컨트롤러)
console.log("[seed] 2/3 규칙 번들 등록");
for (const b of input.bundles) {
  const c = controllerFor(b.issuerDid);
  if (await c.ruleRegistry.read.hasBundle([b.bundle, b.version])) {
    const [bundleHash, schemaHash] = (await c.ruleRegistry.read.getBundle([b.bundle, b.version])) as readonly [Hex, Hex, Address, bigint];
    const diffs = diffRegistered(`${b.bundle}@${b.version}`, { bundleHash, schemaHash },
      { bundleHash: b.bundleHash, schemaHash: b.schemaHash });
    if (diffs.length > 0) mismatches.push(...diffs);
    skip(`${b.bundle}@${b.version} 이미 등록됨${diffs.length > 0 ? " (값 불일치!)" : " (값 일치)"}`);
    continue;
  }
  const args = [b.bundle, b.version, to32(b.bundleHash, `${b.bundle} bundleHash`), to32(b.schemaHash, `${b.bundle} schemaHash`)];
  const hash = (await c.ruleRegistry.write.registerBundle(args, fee)) as Hex;
  await confirm(hash, `registerBundle ${b.bundle}@${b.version} by ${b.issuerDid}`);
}

// ---------------------------------------------------------------- 3) 상태목록 게시 (각 발급기관 컨트롤러)
console.log("[seed] 3/3 상태목록 게시");
for (const s of input.statusLists) {
  const c = controllerFor(s.issuerDid);
  const version = BigInt(s.version);
  let stored: bigint | null = null;
  try {
    const [, v] = (await c.statusListRegistry.read.get([s.listId])) as readonly [Hex, bigint, bigint, Address];
    stored = v;
  } catch (err) {
    if (!String(err).includes("LIST_UNKNOWN")) throw err; // 미게시 → 첫 게시
  }
  if (stored !== null && stored >= version) {
    skip(`${s.listId} 저장 버전 ${stored} >= 요청 ${version}`);
    continue;
  }
  const encoded = s.encodedListBase64url || emptyStatusListBase64url();
  const hash = (await c.statusListRegistry.write.publish([s.listId, stringToHex(encoded), version], fee)) as Hex;
  await confirm(hash, `publish ${s.listId} v${version} (${encoded.length} chars, base64url gzip) by ${s.issuerDid}`);
}

console.log(`[seed] done — sent ${sent} tx, skipped ${skipped}`);
if (mismatches.length > 0) {
  console.error(`[seed] 원장에 이미 등록된 값이 입력과 다릅니다 — 규칙을 바꿨다면 version 을 올려야 합니다:\n  ${mismatches.join("\n  ")}`);
  process.exit(2);
}
