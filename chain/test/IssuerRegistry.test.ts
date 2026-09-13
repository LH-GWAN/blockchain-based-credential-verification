import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, stringToHex } from "viem";
import { DAEGU, IMBANK, deployAll, deployWithIssuers } from "./fixture.js";

describe("IssuerRegistry", () => {
  it("배포자가 governance 가 된다", async () => {
    const f = await deployAll();
    assert.equal((await f.issuerRegistry.read.governance()).toLowerCase(), f.governance.account.address.toLowerCase());
  });

  it("governance 가 발급기관을 등록하면 조회·이벤트·컨트롤러 바인딩이 모두 반영된다", async () => {
    const f = await deployAll();
    const tx = f.issuerRegistry.write.register([DAEGU.did, DAEGU.pubKey, DAEGU.name, f.daegu.account.address]);
    await f.viem.assertions.emitWithArgs(tx, f.issuerRegistry, "IssuerRegistered", [
      DAEGU.did,
      DAEGU.pubKey,
      DAEGU.name,
      f.daegu.account.address,
    ]);

    const issuer = await f.issuerRegistry.read.get([DAEGU.did]);
    assert.equal(issuer.did, DAEGU.did);
    assert.equal(issuer.ed25519PubKey, DAEGU.pubKey);
    assert.equal(issuer.name, DAEGU.name);
    assert.equal(issuer.controller.toLowerCase(), f.daegu.account.address.toLowerCase());
    assert.equal(issuer.active, true);
    assert.ok(issuer.registeredAt > 0n);

    assert.equal(await f.issuerRegistry.read.exists([DAEGU.did]), true);
    assert.equal(await f.issuerRegistry.read.isActiveController([f.daegu.account.address]), true);
    assert.equal(await f.issuerRegistry.read.controllerDid([f.daegu.account.address]), DAEGU.did);
  });

  it("governance 가 아니면 register 할 수 없다", async () => {
    const f = await deployAll();
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.register([DAEGU.did, DAEGU.pubKey, DAEGU.name, f.daegu.account.address], {
        account: f.stranger.account,
      }),
      "NOT_GOVERNANCE",
    );
  });

  it("같은 did 를 두 번 등록하면 revert", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.register([DAEGU.did, DAEGU.pubKey, DAEGU.name, f.stranger.account.address]),
      "ISSUER_EXISTS",
    );
  });

  it("이미 다른 did 에 바인딩된 controller 는 재사용할 수 없다", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.register(["did:dbp:other", DAEGU.pubKey, "다른기관", f.daegu.account.address]),
      "CONTROLLER_BOUND",
    );
  });

  it("빈 did / 0 키 / 0 주소는 거부한다", async () => {
    const f = await deployAll();
    const zero32 = `0x${"00".repeat(32)}` as const;
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.register(["", DAEGU.pubKey, DAEGU.name, f.daegu.account.address]),
      "EMPTY_DID",
    );
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.register([DAEGU.did, zero32, DAEGU.name, f.daegu.account.address]),
      "EMPTY_KEY",
    );
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.register([DAEGU.did, DAEGU.pubKey, DAEGU.name, `0x${"00".repeat(20)}`]),
      "ZERO_CONTROLLER",
    );
  });

  it("setActive 는 governance 만, 정지 시 isActiveController 가 false 가 된다", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.setActive([DAEGU.did, false], { account: f.daegu.account }),
      "NOT_GOVERNANCE",
    );

    await f.viem.assertions.emitWithArgs(
      f.issuerRegistry.write.setActive([DAEGU.did, false]),
      f.issuerRegistry,
      "IssuerStatusChanged",
      [DAEGU.did, false],
    );
    assert.equal((await f.issuerRegistry.read.get([DAEGU.did])).active, false);
    assert.equal(await f.issuerRegistry.read.isActiveController([f.daegu.account.address]), false);
    // 정지돼도 등록 자체는 남아 있다
    assert.equal(await f.issuerRegistry.read.exists([DAEGU.did]), true);
    assert.equal(await f.issuerRegistry.read.controllerDid([f.daegu.account.address]), DAEGU.did);

    await f.issuerRegistry.write.setActive([DAEGU.did, true]);
    assert.equal(await f.issuerRegistry.read.isActiveController([f.daegu.account.address]), true);
  });

  it("setActive 로 미등록 did 를 지정하면 revert", async () => {
    const f = await deployAll();
    await f.viem.assertions.revertWith(f.issuerRegistry.write.setActive(["did:dbp:nobody", true]), "ISSUER_UNKNOWN");
  });

  it("rotateKey 는 governance 만, 새 키가 저장되고 이벤트가 난다", async () => {
    const f = await deployWithIssuers();
    const newKey = keccak256(stringToHex("rotated-key"));
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.rotateKey([DAEGU.did, newKey], { account: f.daegu.account }),
      "NOT_GOVERNANCE",
    );
    await f.viem.assertions.emitWithArgs(
      f.issuerRegistry.write.rotateKey([DAEGU.did, newKey]),
      f.issuerRegistry,
      "IssuerKeyRotated",
      [DAEGU.did, newKey],
    );
    assert.equal((await f.issuerRegistry.read.get([DAEGU.did])).ed25519PubKey, newKey);
  });

  it("미등록 did 조회는 revert, exists/isActiveController/controllerDid 는 안전한 기본값", async () => {
    const f = await deployAll();
    await f.viem.assertions.revertWith(f.issuerRegistry.read.get(["did:dbp:nobody"]), "ISSUER_UNKNOWN");
    assert.equal(await f.issuerRegistry.read.exists(["did:dbp:nobody"]), false);
    assert.equal(await f.issuerRegistry.read.isActiveController([f.stranger.account.address]), false);
    assert.equal(await f.issuerRegistry.read.controllerDid([f.stranger.account.address]), "");
  });

  it("transferGovernance 후에는 새 governance 만 등록할 수 있다", async () => {
    const f = await deployAll();
    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.transferGovernance([f.stranger.account.address], { account: f.stranger.account }),
      "NOT_GOVERNANCE",
    );
    await f.issuerRegistry.write.transferGovernance([f.stranger.account.address]);
    assert.equal((await f.issuerRegistry.read.governance()).toLowerCase(), f.stranger.account.address.toLowerCase());

    await f.viem.assertions.revertWith(
      f.issuerRegistry.write.register([IMBANK.did, IMBANK.pubKey, IMBANK.name, f.imbank.account.address]),
      "NOT_GOVERNANCE",
    );
    await f.issuerRegistry.write.register([IMBANK.did, IMBANK.pubKey, IMBANK.name, f.imbank.account.address], {
      account: f.stranger.account,
    });
    assert.equal(await f.issuerRegistry.read.exists([IMBANK.did]), true);
  });
});
