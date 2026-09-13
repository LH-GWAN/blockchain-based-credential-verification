// 원장 개인정보 무기록 스캔 (§8 "원장 개인정보 무기록 테스트")
//   node scripts/scan-pii.ts [--rpc http://127.0.0.1:8545] [--names 김복례,이순자] [--from 0] [--to latest]
//   RPC_URL 환경변수도 인식한다. Hardhat 의 `run` 태스크는 추가 인자를 전달하지 못하므로 plain Node 로 실행한다.
//
// 대상 RPC 의 모든 블록 → 모든 트랜잭션 calldata, 모든 이벤트 로그 data 를 UTF-8 로 (손실 허용) 디코딩해
// 다음이 하나도 없음을 assert 하고, 발견 시 보고서를 출력하고 종료코드 1 로 끝난다.
//   - --names 로 받은 이름 목록
//   - 주민번호 패턴  \d{6}-?[1-4]\d{6}
//   - monthlyIncomeKRW / annualIncomeKRW / birthDate 리터럴
//   - JWT 로 보이는 토큰 (eyJ... 헤더 + '.' 구분자)
import { parseArgs } from "node:util";
import { createPublicClient, hexToBytes, http } from "viem";
import type { Hex } from "viem";

const { values: args } = parseArgs({
  options: {
    rpc: { type: "string" },
    names: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
  allowPositionals: true, // `pnpm scan-pii -- --names …` 처럼 `--` 가 끼어도 동작
});

const rpcUrl = args.rpc ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
const names = (args.names ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const LITERALS = ["monthlyIncomeKRW", "annualIncomeKRW", "birthDate"] as const;
const RRN = /\d{6}-?[1-4]\d{6}/; // 주민등록번호
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/; // base64url("{") 로 시작하는 헤더 + payload 구분자

interface Finding {
  block: bigint;
  tx: Hex;
  where: "calldata" | "log";
  rule: string;
  snippet: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** ABI 인코딩된 바이트열을 통째로 UTF-8 로 풀어 문자열 인자(한글 포함)를 노출시킨다. */
function decodeLossy(data: Hex): string {
  if (!data || data === "0x") return "";
  return utf8.decode(hexToBytes(data));
}

function snippetAround(text: string, index: number, len: number): string {
  const s = Math.max(0, index - 12);
  return JSON.stringify(text.slice(s, index + len + 12));
}

export function scanText(text: string): { rule: string; snippet: string }[] {
  const hits: { rule: string; snippet: string }[] = [];
  for (const name of names) {
    const i = text.indexOf(name);
    if (i >= 0) hits.push({ rule: `name:${name}`, snippet: snippetAround(text, i, name.length) });
  }
  for (const lit of LITERALS) {
    const i = text.indexOf(lit);
    if (i >= 0) hits.push({ rule: `literal:${lit}`, snippet: snippetAround(text, i, lit.length) });
  }
  const rrn = RRN.exec(text);
  if (rrn) hits.push({ rule: "rrn-pattern", snippet: snippetAround(text, rrn.index, rrn[0].length) });
  const jwt = JWT.exec(text);
  if (jwt) hits.push({ rule: "jwt-like", snippet: snippetAround(text, jwt.index, Math.min(jwt[0].length, 24)) });
  return hits;
}

// 스캐너 자체가 동작하는지 합성 문자열로 자가 점검 (실제 개인정보가 아닌 조합 문자열)
function selfTest() {
  const fakeRrn = ["900101", "1234567"].join("-");
  const probes: [string, string][] = [
    [`{"${LITERALS[2]}":"1960-01-01"}`, `literal:${LITERALS[2]}`],
    [`id=${fakeRrn}`, "rrn-pattern"],
    ["token=eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiIxIn0.sig", "jwt-like"],
  ];
  for (const [text, rule] of probes) {
    if (!scanText(text).some((h) => h.rule === rule)) throw new Error(`self-test 실패: ${rule}`);
  }
  if (names.length > 0 && !scanText(`name=${names[0]}`).some((h) => h.rule === `name:${names[0]}`)) {
    throw new Error("self-test 실패: names");
  }
}

async function main() {
  selfTest();
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  const latest = await client.getBlockNumber();
  const from = args.from !== undefined ? BigInt(args.from) : 0n;
  const to = args.to !== undefined && args.to !== "latest" ? BigInt(args.to) : latest;

  console.log(`[scan-pii] rpc=${rpcUrl} chainId=${chainId} blocks ${from}..${to} names=${names.length}`);

  const findings: Finding[] = [];
  let blocks = 0;
  let txs = 0;
  let logs = 0;

  for (let n = from; n <= to; n++) {
    const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
    blocks += 1;
    for (const tx of block.transactions) {
      txs += 1;
      for (const hit of scanText(decodeLossy(tx.input))) {
        findings.push({ block: n, tx: tx.hash, where: "calldata", ...hit });
      }
      if (args.verbose) console.log(`  block ${n} tx ${tx.hash} calldata ${(tx.input.length - 2) / 2} bytes`);
    }
  }

  // 이벤트 로그는 블록 범위로 한 번에 조회 (topics 는 keccak 해시라 data 만 검사)
  const STEP = 2000n;
  for (let start = from; start <= to; start += STEP) {
    const end = start + STEP - 1n < to ? start + STEP - 1n : to;
    const chunk = await client.getLogs({ fromBlock: start, toBlock: end });
    for (const log of chunk) {
      logs += 1;
      for (const hit of scanText(decodeLossy(log.data))) {
        findings.push({ block: log.blockNumber ?? start, tx: log.transactionHash ?? "0x", where: "log", ...hit });
      }
    }
  }

  console.log(`[scan-pii] scanned blocks=${blocks} txs=${txs} logs=${logs} findings=${findings.length}`);
  for (const f of findings) {
    console.log(`  X block ${f.block} ${f.where} tx=${f.tx} rule=${f.rule} snippet=${f.snippet}`);
  }
  if (findings.length > 0) {
    console.error("[scan-pii] FAIL - 원장에 개인정보로 보이는 데이터가 있습니다");
    process.exit(1);
  }
  console.log("[scan-pii] PASS - 이름/주민번호/소득 필드/생년월일/JWT 없음");
}

await main();
