// 원장 개인정보 무기록 스캔 (§8 "원장 개인정보 무기록 테스트")
//   node scripts/scan-pii.ts [--rpc http://127.0.0.1:8545] [--citizens ../data/citizens.json] [--names 추가이름,…]
//                            [--dids did:key:z…,…] [--from 0] [--to latest]
//   RPC_URL 환경변수도 인식한다. Hardhat 의 `run` 태스크는 추가 인자를 전달하지 못하므로 plain Node 로 실행한다.
//
// 대상 RPC 의 모든 블록 → 모든 트랜잭션 calldata, 모든 이벤트 로그 data 를 검사해 다음이 하나도 없음을 assert 하고,
// 발견 시 보고서를 출력하고 종료코드 1 로 끝난다. 탐지 대상은 기본으로 data/citizens.json(합성 시민 30명)에서 만든다.
//   [문자열 — calldata·로그를 UTF-8 로 손실 허용 디코딩]
//   - 시민 이름, citizenId(C-001…), 생년월일 값  (+ --names 로 추가한 이름)
//   - 소득 값의 10진 문자열 (monthlyIncomeKRW·annualIncomeKRW, 앞뒤가 숫자가 아닐 때)
//   - 주민번호 패턴  \d{6}-?[1-4]\d{6}
//   - monthlyIncomeKRW / annualIncomeKRW / birthDate 리터럴
//   - JWT 로 보이는 토큰 (eyJ... 헤더 + '.' 구분자)
//   - 시민 지갑 DID (did:key:z…) 와 --dids 로 준 DID  ※ 발급기관 DID(did:dbp:…)는 공개 정보라 대상이 아니다
//   [정수 — calldata·로그 data·로그 topics(indexed 값)의 원시 바이트]
//   - 소득 값의 32바이트 big-endian 정수 인코딩(ABI uint256 한 칸). 1바이트 경계 어디에 있어도 잡는다.
// 탐지하지 못하는 것(한계): 해시·암호화·압축된 값, 32바이트가 아닌 정수 폭(uint64 packed 등), 10,000 미만 정수,
//   citizens.json 에 없는 사람의 이름·소득, 블록 헤더(extraData) — 원장 쓰기 경로는 모두 calldata 를 거치므로
//   calldata·로그가 스캔 범위다.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, hexToBytes, http } from "viem";
import type { Hex, PublicClient } from "viem";

export interface PiiRules {
  names: string[];
  citizenIds: string[];
  birthDates: string[];
  incomes: bigint[]; // 원 단위 정수
  dids: string[];
}

export interface Hit {
  rule: string;
  snippet: string;
}

export interface Finding extends Hit {
  block: bigint;
  tx: Hex;
  where: "calldata" | "log";
}

const LITERALS = ["monthlyIncomeKRW", "annualIncomeKRW", "birthDate"] as const;
const INCOME_FIELDS = ["monthlyIncomeKRW", "annualIncomeKRW"] as const;
const MIN_INCOME = 10_000n; // 이보다 작은 정수는 오프셋·길이·버전과 겹쳐 오탐이 난다
const RRN = /\d{6}-?[1-4]\d{6}/; // 주민등록번호
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/; // base64url("{") 로 시작하는 헤더 + payload 구분자
const HOLDER_DID = /did:key:z[1-9A-HJ-NP-Za-km-z]{8,}/; // 시민 지갑 DID (Ed25519 multibase)

export const DEFAULT_CITIZENS_PATH = fileURLToPath(new URL("../../data/citizens.json", import.meta.url));

export const emptyRules = (): PiiRules => ({ names: [], citizenIds: [], birthDates: [], incomes: [], dids: [] });

/** data/citizens.json 의 합성 시민 데이터에서 탐지 목록을 만든다. */
export function loadCitizenRules(path = DEFAULT_CITIZENS_PATH): PiiRules {
  const doc = JSON.parse(readFileSync(path, "utf8")) as { citizens: Record<string, unknown>[] };
  const rules = emptyRules();
  const incomes = new Set<bigint>();
  for (const c of doc.citizens) {
    if (typeof c.name === "string") rules.names.push(c.name);
    if (typeof c.citizenId === "string") rules.citizenIds.push(c.citizenId);
    if (typeof c.birthDate === "string") rules.birthDates.push(c.birthDate);
    for (const f of INCOME_FIELDS) {
      const v = c[f];
      if (typeof v === "number" && Number.isInteger(v) && BigInt(v) >= MIN_INCOME) incomes.add(BigInt(v));
    }
  }
  rules.incomes = [...incomes];
  return rules;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function mergeRules(a: PiiRules, b: Partial<PiiRules>): PiiRules {
  return {
    names: uniq([...a.names, ...(b.names ?? [])]),
    citizenIds: uniq([...a.citizenIds, ...(b.citizenIds ?? [])]),
    birthDates: uniq([...a.birthDates, ...(b.birthDates ?? [])]),
    incomes: uniq([...a.incomes, ...(b.incomes ?? [])]),
    dids: uniq([...a.dids, ...(b.dids ?? [])]),
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** ABI 인코딩된 바이트열을 통째로 UTF-8 로 풀어 문자열 인자(한글 포함)를 노출시킨다. */
export function decodeLossy(data: Hex): string {
  if (!data || data === "0x") return "";
  return utf8.decode(hexToBytes(data));
}

function snippetAround(text: string, index: number, len: number): string {
  const s = Math.max(0, index - 12);
  return JSON.stringify(text.slice(s, index + len + 12));
}

export function scanText(text: string, rules: PiiRules): Hit[] {
  const hits: Hit[] = [];
  const exact = (kind: string, values: string[]) => {
    for (const v of values) {
      const i = text.indexOf(v);
      if (i >= 0) hits.push({ rule: `${kind}:${v}`, snippet: snippetAround(text, i, v.length) });
    }
  };
  exact("name", rules.names);
  exact("citizenId", rules.citizenIds);
  exact("birthDate", rules.birthDates);
  exact("did", rules.dids);
  for (const n of rules.incomes) {
    const m = new RegExp(`(?<!\\d)${n}(?!\\d)`).exec(text);
    if (m) hits.push({ rule: `income-decimal:${n}`, snippet: snippetAround(text, m.index, m[0].length) });
  }
  for (const lit of LITERALS) {
    const i = text.indexOf(lit);
    if (i >= 0) hits.push({ rule: `literal:${lit}`, snippet: snippetAround(text, i, lit.length) });
  }
  const rrn = RRN.exec(text);
  if (rrn) hits.push({ rule: "rrn-pattern", snippet: snippetAround(text, rrn.index, rrn[0].length) });
  const jwt = JWT.exec(text);
  if (jwt) hits.push({ rule: "jwt-like", snippet: snippetAround(text, jwt.index, Math.min(jwt[0].length, 24)) });
  const did = HOLDER_DID.exec(text);
  if (did) hits.push({ rule: "holder-did", snippet: snippetAround(text, did.index, Math.min(did[0].length, 24)) });
  return hits;
}

/** 소득 값의 32바이트 big-endian 정수 인코딩(ABI uint256)을 원시 바이트에서 찾는다. */
export function scanWords(data: Hex, rules: PiiRules): Hit[] {
  const hits: Hit[] = [];
  const hex = (data ?? "0x").toLowerCase().replace(/^0x/, "");
  if (hex.length < 64) return hits;
  for (const n of rules.incomes) {
    const word = n.toString(16).padStart(64, "0");
    for (let i = hex.indexOf(word); i >= 0; i = hex.indexOf(word, i + 1)) {
      if (i % 2 === 0) {
        hits.push({ rule: `income-uint256:${n}`, snippet: `byte ${i / 2}: 0x${word.replace(/^0+/, "")}` });
        break;
      }
    }
  }
  return hits;
}

export function scanData(data: Hex, rules: PiiRules): Hit[] {
  return [...scanText(decodeLossy(data), rules), ...scanWords(data, rules)];
}

/** 스캐너 자체가 동작하는지 합성 값으로 자가 점검 (실제 개인정보가 아닌 조합 문자열·정수). */
export function selfTest(rules: PiiRules): void {
  const fakeRrn = ["900101", "1234567"].join("-");
  const fake: PiiRules = { names: ["가나다"], citizenIds: ["C-999"], birthDates: ["1900-01-01"], incomes: [1234567n], dids: [] };
  const word = (n: bigint) => `0x${"ab".repeat(4)}${n.toString(16).padStart(64, "0")}` as Hex;
  const probes: [Hit[], string][] = [
    [scanText(`{"${LITERALS[2]}":"1960-01-01"}`, fake), `literal:${LITERALS[2]}`],
    [scanText(`id=${fakeRrn}`, fake), "rrn-pattern"],
    [scanText("token=eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiIxIn0.sig", fake), "jwt-like"],
    [scanText("holder=did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", fake), "holder-did"],
    [scanText("who=C-999;", fake), "citizenId:C-999"],
    [scanText("pay=1234567원", fake), "income-decimal:1234567"],
    [scanWords(word(1234567n), fake), "income-uint256:1234567"],
  ];
  for (const [hits, rule] of probes) {
    if (!hits.some((h) => h.rule === rule)) throw new Error(`self-test 실패: ${rule}`);
  }
  if (scanText("v=12345678", fake).some((h) => h.rule.startsWith("income-decimal"))) {
    throw new Error("self-test 실패: income-decimal 경계");
  }
  if (rules.names.length > 0 && !scanText(`name=${rules.names[0]}`, rules).some((h) => h.rule === `name:${rules.names[0]}`)) {
    throw new Error("self-test 실패: names");
  }
}

export async function scanChain(
  client: Pick<PublicClient, "getBlock" | "getLogs">,
  opts: { from: bigint; to: bigint; rules: PiiRules; verbose?: boolean },
): Promise<{ blocks: number; txs: number; logs: number; findings: Finding[] }> {
  const { from, to, rules } = opts;
  const findings: Finding[] = [];
  let blocks = 0;
  let txs = 0;
  let logs = 0;

  for (let n = from; n <= to; n++) {
    const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
    blocks += 1;
    for (const tx of block.transactions) {
      txs += 1;
      for (const hit of scanData(tx.input, rules)) {
        findings.push({ block: n, tx: tx.hash, where: "calldata", ...hit });
      }
      if (opts.verbose) console.log(`  block ${n} tx ${tx.hash} calldata ${(tx.input.length - 2) / 2} bytes`);
    }
  }

  // 이벤트 로그는 블록 범위로 한 번에 조회. data 는 문자열·정수 모두, topics[1..](indexed 값)는 정수만 검사한다
  // (indexed string 은 keccak 해시라 문자열로 풀리지 않지만, indexed bytes32/uint 는 값이 그대로 들어간다).
  const STEP = 2000n;
  for (let start = from; start <= to; start += STEP) {
    const end = start + STEP - 1n < to ? start + STEP - 1n : to;
    const chunk = await client.getLogs({ fromBlock: start, toBlock: end });
    for (const log of chunk) {
      logs += 1;
      const topics = `0x${log.topics.slice(1).map((t) => t.slice(2)).join("")}` as Hex;
      for (const hit of [...scanData(log.data, rules), ...scanWords(topics, rules)]) {
        findings.push({ block: log.blockNumber ?? start, tx: log.transactionHash ?? "0x", where: "log", ...hit });
      }
    }
  }
  return { blocks, txs, logs, findings };
}

const splitList = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

async function main() {
  const { values: args } = parseArgs({
    options: {
      rpc: { type: "string" },
      citizens: { type: "string" },
      names: { type: "string" },
      dids: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: true, // `pnpm scan-pii -- --names …` 처럼 `--` 가 끼어도 동작
  });
  const rpcUrl = args.rpc ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const citizensPath = args.citizens ?? DEFAULT_CITIZENS_PATH;
  const rules = mergeRules(loadCitizenRules(citizensPath), { names: splitList(args.names), dids: splitList(args.dids) });
  selfTest(rules);

  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  const latest = await client.getBlockNumber();
  const from = args.from !== undefined ? BigInt(args.from) : 0n;
  const to = args.to !== undefined && args.to !== "latest" ? BigInt(args.to) : latest;

  console.log(
    `[scan-pii] rpc=${rpcUrl} chainId=${chainId} blocks ${from}..${to} citizens=${citizensPath} ` +
      `names=${rules.names.length} citizenIds=${rules.citizenIds.length} incomes=${rules.incomes.length} dids=${rules.dids.length}`,
  );

  const { blocks, txs, logs, findings } = await scanChain(client, { from, to, rules, verbose: args.verbose });

  console.log(`[scan-pii] scanned blocks=${blocks} txs=${txs} logs=${logs} findings=${findings.length}`);
  for (const f of findings) {
    console.log(`  X block ${f.block} ${f.where} tx=${f.tx} rule=${f.rule} snippet=${f.snippet}`);
  }
  if (findings.length > 0) {
    console.error("[scan-pii] FAIL - 원장에 개인정보로 보이는 데이터가 있습니다");
    process.exit(1);
  }
  console.log("[scan-pii] PASS - 이름/citizenId/생년월일/소득(문자열·uint256)/주민번호/JWT/지갑 DID 없음");
}

// 테스트에서 import 할 때는 실행하지 않는다 (import.meta.main 은 Node 22.18+/24.2+, 없으면 경로 비교)
function invokedDirectly(): boolean {
  const flag = (import.meta as ImportMeta & { main?: boolean }).main;
  if (typeof flag === "boolean") return flag;
  if (!process.argv[1]) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url)).normalize("NFC");
    return realpathSync(process.argv[1]).normalize("NFC") === self;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  await main();
}
