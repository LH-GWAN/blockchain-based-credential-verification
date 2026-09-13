import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, stringToHex } from "viem";
import { DAEGU, deployWithIssuers } from "./fixture.js";

const BUNDLE = "daegu-eligibility";
const VERSION = "2026.1";
const bundleHash = keccak256(stringToHex("bundle-2026.1"));
const schemaHash = keccak256(stringToHex("schema-2026.1"));

describe("RuleRegistry", () => {
  it("IssuerRegistry 주소를 기억한다", async () => {
    const f = await deployWithIssuers();
    assert.equal((await f.ruleRegistry.read.issuerRegistry()).toLowerCase(), f.issuerRegistry.address.toLowerCase());
  });

  it("활성 발급기관 컨트롤러가 번들을 등록하면 조회·이벤트가 반영된다", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.emitWithArgs(
      f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, bundleHash, schemaHash], { account: f.daegu.account }),
      f.ruleRegistry,
      "BundleRegistered",
      [BUNDLE, VERSION, bundleHash, schemaHash, f.daegu.account.address],
    );
    const [h, s, by, at] = await f.ruleRegistry.read.getBundle([BUNDLE, VERSION]);
    assert.equal(h, bundleHash);
    assert.equal(s, schemaHash);
    assert.equal(by.toLowerCase(), f.daegu.account.address.toLowerCase());
    assert.ok(at > 0n);
    assert.equal(await f.ruleRegistry.read.hasBundle([BUNDLE, VERSION]), true);
  });

  it("같은 (bundle, version) 은 불변 — 같은 기관도, 다른 기관도 덮어쓸 수 없다", async () => {
    const f = await deployWithIssuers();
    await f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, bundleHash, schemaHash], { account: f.daegu.account });

    const other = keccak256(stringToHex("tampered"));
    await f.viem.assertions.revertWith(
      f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, other, schemaHash], { account: f.daegu.account }),
      "BUNDLE_EXISTS",
    );
    await f.viem.assertions.revertWith(
      f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, other, schemaHash], { account: f.imbank.account }),
      "BUNDLE_EXISTS",
    );
    // 원래 값 유지
    const [h] = await f.ruleRegistry.read.getBundle([BUNDLE, VERSION]);
    assert.equal(h, bundleHash);

    // 다른 버전은 새로 등록 가능
    await f.ruleRegistry.write.registerBundle([BUNDLE, "2026.2", other, schemaHash], { account: f.daegu.account });
    assert.equal(await f.ruleRegistry.read.hasBundle([BUNDLE, "2026.2"]), true);
  });

  it("발급기관이 아닌 주소는 등록할 수 없다", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.revertWith(
      f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, bundleHash, schemaHash], { account: f.stranger.account }),
      "NOT_ACTIVE_ISSUER",
    );
    // governance 라도 발급기관 컨트롤러가 아니면 불가
    await f.viem.assertions.revertWith(
      f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, bundleHash, schemaHash]),
      "NOT_ACTIVE_ISSUER",
    );
  });

  it("정지된 발급기관은 등록할 수 없고, 재활성화하면 가능하다", async () => {
    const f = await deployWithIssuers();
    await f.issuerRegistry.write.setActive([DAEGU.did, false]);
    await f.viem.assertions.revertWith(
      f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, bundleHash, schemaHash], { account: f.daegu.account }),
      "NOT_ACTIVE_ISSUER",
    );
    await f.issuerRegistry.write.setActive([DAEGU.did, true]);
    await f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, bundleHash, schemaHash], { account: f.daegu.account });
    assert.equal(await f.ruleRegistry.read.hasBundle([BUNDLE, VERSION]), true);
  });

  it("미등록 번들 조회는 revert, hasBundle 은 false", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.revertWith(f.ruleRegistry.read.getBundle([BUNDLE, "9999.9"]), "BUNDLE_UNKNOWN");
    assert.equal(await f.ruleRegistry.read.hasBundle([BUNDLE, "9999.9"]), false);
  });

  it("빈 식별자 / 0 해시는 거부한다", async () => {
    const f = await deployWithIssuers();
    const zero32 = `0x${"00".repeat(32)}` as const;
    await f.viem.assertions.revertWith(
      f.ruleRegistry.write.registerBundle(["", VERSION, bundleHash, schemaHash], { account: f.daegu.account }),
      "EMPTY_ID",
    );
    await f.viem.assertions.revertWith(
      f.ruleRegistry.write.registerBundle([BUNDLE, VERSION, zero32, schemaHash], { account: f.daegu.account }),
      "EMPTY_HASH",
    );
  });
});
