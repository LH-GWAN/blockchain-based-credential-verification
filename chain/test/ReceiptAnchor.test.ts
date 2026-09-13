import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256, stringToHex } from "viem";
import { deployAll } from "./fixture.js";

// 영수증 원문(JCS)+salt 의 sha256 — 여기서는 임의 문자열로 대신한다(원문은 체인에 올라가지 않는다)
const consentHash = sha256(stringToHex("consent-receipt-with-salt-A"));
const presentationHash = sha256(stringToHex("presentation-receipt-with-salt-B"));

describe("ReceiptAnchor", () => {
  it("anchor 는 Anchored(saltedHash, kind, by, ts) 이벤트를 내고 anchoredAt 에 블록 시각을 기록한다", async () => {
    const f = await deployAll();
    const txHash = await f.receiptAnchor.write.anchor([consentHash, 1]);
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash: txHash });
    const block = await f.publicClient.getBlock({ blockNumber: receipt.blockNumber });

    await f.viem.assertions.emitWithArgs(txHash, f.receiptAnchor, "Anchored", [
      consentHash,
      1,
      f.governance.account.address,
      block.timestamp,
    ]);
    assert.equal(await f.receiptAnchor.read.anchoredAt([consentHash]), block.timestamp);
  });

  it("누구나 앵커할 수 있다 (제출 영수증은 verifier 가 올린다)", async () => {
    const f = await deployAll();
    const txHash = await f.receiptAnchor.write.anchor([presentationHash, 2], { account: f.stranger.account });
    const receipt = await f.publicClient.waitForTransactionReceipt({ hash: txHash });
    const block = await f.publicClient.getBlock({ blockNumber: receipt.blockNumber });

    await f.viem.assertions.emitWithArgs(txHash, f.receiptAnchor, "Anchored", [
      presentationHash,
      2,
      f.stranger.account.address,
      block.timestamp,
    ]);
    assert.equal(await f.receiptAnchor.read.anchoredAt([presentationHash]), block.timestamp);
  });

  it("같은 해시는 두 번 앵커할 수 없다", async () => {
    const f = await deployAll();
    await f.receiptAnchor.write.anchor([consentHash, 1]);
    await f.viem.assertions.revertWith(f.receiptAnchor.write.anchor([consentHash, 1]), "ALREADY_ANCHORED");
    // kind 가 달라도 해시가 같으면 거부
    await f.viem.assertions.revertWith(
      f.receiptAnchor.write.anchor([consentHash, 2], { account: f.stranger.account }),
      "ALREADY_ANCHORED",
    );
  });

  it("kind 는 1(consent) 또는 2(presentation) 만 허용", async () => {
    const f = await deployAll();
    await f.viem.assertions.revertWith(f.receiptAnchor.write.anchor([consentHash, 0]), "BAD_KIND");
    await f.viem.assertions.revertWith(f.receiptAnchor.write.anchor([consentHash, 3]), "BAD_KIND");
    assert.equal(await f.receiptAnchor.read.KIND_CONSENT(), 1);
    assert.equal(await f.receiptAnchor.read.KIND_PRESENTATION(), 2);
  });

  it("앵커된 적 없는 해시의 anchoredAt 은 0, 0 해시는 거부", async () => {
    const f = await deployAll();
    const zero32 = `0x${"00".repeat(32)}` as const;
    assert.equal(await f.receiptAnchor.read.anchoredAt([presentationHash]), 0n);
    await f.viem.assertions.revertWith(f.receiptAnchor.write.anchor([zero32, 1]), "EMPTY_HASH");
  });
});
