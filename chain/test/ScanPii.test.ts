// scan-pii 탐지 범위 테스트 (F47): citizens.json 에서 만든 이름·citizenId·생년월일·소득(문자열·uint256)·지갑 DID
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { encodeAbiParameters, pad, sha256, stringToHex, toHex } from "viem";
import { loadCitizenRules, scanChain, scanData, scanText, scanWords, selfTest } from "../scripts/scan-pii.js";
import { DAEGU, deployWithIssuers } from "./fixture.js";

const rules = loadCitizenRules();

describe("scan-pii", () => {
  it("탐지 목록은 data/citizens.json 에서 만든다 (이름·citizenId·생년월일·소득)", () => {
    assert.equal(rules.names.length, 30);
    assert.ok(rules.names.includes("김복례"));
    assert.ok(!rules.names.includes("이순자") && !rules.names.includes("박영희")); // 예전 스모크 인자는 없는 이름이었다
    assert.ok(rules.citizenIds.includes("C-001"));
    assert.ok(rules.birthDates.includes("1958-03-12"));
    assert.ok(rules.incomes.includes(1_000_000n) && rules.incomes.includes(12_000_000n));
    assert.ok(rules.incomes.every((n) => n >= 10_000n));
    selfTest(rules);
  });

  it("소득이 ABI uint256 으로 calldata 에 들어가면 잡는다 (문자열 패턴만으로는 못 잡던 경우)", () => {
    const data = encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["dbp:status:daegu:list-1", 1_000_000n]);
    assert.deepEqual(scanText(new TextDecoder().decode(Buffer.from(data.slice(2), "hex")), { ...rules, incomes: [] }), []);
    assert.ok(scanWords(data, rules).some((h) => h.rule === "income-uint256:1000000"));
    // 4바이트 selector 뒤(정렬이 어긋난 위치)에 있어도 잡는다
    assert.ok(scanWords(`0xdeadbeef${data.slice(2)}`, rules).some((h) => h.rule === "income-uint256:1000000"));
  });

  it("citizenId·생년월일·소득 10진 문자열·지갑 DID 를 잡는다", () => {
    const rule = (text: string) => scanData(stringToHex(text), rules).map((h) => h.rule.split(":")[0]);
    assert.ok(rule("subject=C-001").includes("citizenId"));
    assert.ok(rule("born 1958-03-12").includes("birthDate"));
    assert.ok(rule("income=1000000").includes("income-decimal"));
    assert.ok(!rule("v=110000000").includes("income-decimal")); // 다른 숫자의 일부는 오탐하지 않는다
    assert.ok(rule("sub=did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK").includes("holder-did"));
    assert.deepEqual(rule(`issuer=${DAEGU.did}`), []); // 발급기관 DID 는 공개 정보
  });

  it("데모와 같은 원장 쓰기(발급기관·번들·상태목록·영수증)만 있으면 findings=0", async () => {
    const f = await deployWithIssuers();
    const encoded = gzipSync(Buffer.alloc(131072 / 8)).toString("base64url");
    await f.ruleRegistry.write.registerBundle(
      ["daegu-eligibility", "2026.2", sha256(stringToHex("bundle")), sha256(stringToHex("schema"))],
      { account: f.daegu.account },
    );
    await f.statusListRegistry.write.publish(["dbp:status:daegu:list-1", stringToHex(encoded), 1n], { account: f.daegu.account });
    await f.receiptAnchor.write.anchor([sha256(stringToHex("consent-receipt+salt")), 1]);
    await f.receiptAnchor.write.anchor([sha256(stringToHex("presentation-receipt+salt")), 2], { account: f.imbank.account });

    const to = await f.publicClient.getBlockNumber();
    const r = await scanChain(f.publicClient, { from: 0n, to, rules });
    assert.ok(r.txs >= 9 && r.logs >= 4, `txs=${r.txs} logs=${r.logs}`);
    assert.deepEqual(r.findings, []);
  });

  it("원장에 소득 정수·시민 이름이 올라가면 FAIL 사유로 잡는다", async () => {
    const f = await deployWithIssuers();
    const from = (await f.publicClient.getBlockNumber()) + 1n;
    await f.receiptAnchor.write.anchor([pad(toHex(12_000_000n), { size: 32 }), 1]); // bytes32 칸에 연소득 정수
    await f.issuerRegistry.write.register(["did:dbp:leak", sha256(stringToHex("k")), "김복례", f.stranger.account.address]);
    const to = await f.publicClient.getBlockNumber();
    const r = await scanChain(f.publicClient, { from, to, rules });
    const found = new Set(r.findings.map((x) => `${x.where}:${x.rule}`));
    assert.ok(found.has("calldata:income-uint256:12000000"), [...found].join(","));
    assert.ok(found.has("log:income-uint256:12000000"), [...found].join(","));
    assert.ok(found.has("calldata:name:김복례") && found.has("log:name:김복례"), [...found].join(","));
  });
});
