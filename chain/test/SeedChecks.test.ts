// seed.ts 입력 점검 (F56): 자리표시자 키·해시는 원장에 쓰기 전에 거부, 이미 등록된 값은 비교 후에만 skip
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { diffRegistered, findPlaceholders, isPlaceholder32 } from "../scripts/seed-checks.js";
import type { SeedInput } from "../scripts/seed-checks.js";

const example: SeedInput = JSON.parse(readFileSync(new URL("../seed-input.example.json", import.meta.url), "utf8"));

describe("seed-checks", () => {
  it("반복 바이트 32바이트 값은 자리표시자다", () => {
    assert.equal(isPlaceholder32(`0x${"a1".repeat(32)}`), true);
    assert.equal(isPlaceholder32(`0x${"00".repeat(32)}`), true);
    assert.equal(isPlaceholder32("0x4f1c3d8e2a7b6c5d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d"), false);
    assert.equal(isPlaceholder32("0xa1a1"), false); // 길이가 다르면 형식 오류는 seed.ts 의 to32 가 따로 잡는다
  });

  it("예시 입력(seed-input.example.json)은 그대로 등록되지 않는다", () => {
    const bad = findPlaceholders(example);
    assert.ok(bad.includes("issuers[did:dbp:daegu].ed25519PubKeyHex"), bad.join(","));
    assert.ok(bad.includes("bundles[daegu-eligibility@2026.2].bundleHash"), bad.join(","));
    assert.equal(bad.length, 4);
  });

  it("이미 등록된 값과 입력이 다르면 차이를 보고한다 (대소문자·0x 무시)", () => {
    const h = "0x4f1c3d8e2a7b6c5d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d";
    assert.deepEqual(diffRegistered("b", { bundleHash: h.toUpperCase().replace("0X", "0x") }, { bundleHash: h.slice(2) }), []);
    const d = diffRegistered("daegu-eligibility@2026.2", { bundleHash: h }, { bundleHash: `0x${"c3".repeat(32)}` });
    assert.equal(d.length, 1);
    assert.match(d[0], /bundleHash/);
  });
});
