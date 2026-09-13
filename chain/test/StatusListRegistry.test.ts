import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stringToHex } from "viem";
import { DAEGU, deployWithIssuers } from "./fixture.js";

const LIST_ID = "dbp:status:daegu:list-1";
// 실제 값은 gzip+base64url 문자열이지만 컨트랙트는 바이트열로만 다룬다
const list1 = stringToHex("H4sIAAAAAAAA_-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA");
const list2 = stringToHex("H4sIAAAAAAAA_-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAB");

describe("StatusListRegistry", () => {
  it("활성 발급기관의 첫 게시: 게시자가 소유자가 되고 조회·이벤트가 반영된다", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.emitWithArgs(
      f.statusListRegistry.write.publish([LIST_ID, list1, 1n], { account: f.daegu.account }),
      f.statusListRegistry,
      "StatusListPublished",
      [LIST_ID, 1n, f.daegu.account.address],
    );
    const [encoded, version, updatedAt, owner] = await f.statusListRegistry.read.get([LIST_ID]);
    assert.equal(encoded, list1);
    assert.equal(version, 1n);
    assert.ok(updatedAt > 0n);
    assert.equal(owner.toLowerCase(), f.daegu.account.address.toLowerCase());
  });

  it("발급기관이 아닌 주소는 첫 게시를 할 수 없다", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, list1, 1n], { account: f.stranger.account }),
      "NOT_ACTIVE_ISSUER",
    );
  });

  it("정지된 발급기관은 첫 게시를 할 수 없다", async () => {
    const f = await deployWithIssuers();
    await f.issuerRegistry.write.setActive([DAEGU.did, false]);
    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, list1, 1n], { account: f.daegu.account }),
      "NOT_ACTIVE_ISSUER",
    );
  });

  it("소유자만 갱신할 수 있다 (다른 활성 발급기관도 불가)", async () => {
    const f = await deployWithIssuers();
    await f.statusListRegistry.write.publish([LIST_ID, list1, 1n], { account: f.daegu.account });
    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, list2, 2n], { account: f.imbank.account }),
      "NOT_LIST_OWNER",
    );
    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, list2, 2n], { account: f.stranger.account }),
      "NOT_LIST_OWNER",
    );
  });

  it("version 은 엄격히 증가해야 한다", async () => {
    const f = await deployWithIssuers();
    // 첫 게시는 version >= 1
    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, list1, 0n], { account: f.daegu.account }),
      "VERSION_NOT_INCREASING",
    );
    await f.statusListRegistry.write.publish([LIST_ID, list1, 5n], { account: f.daegu.account });

    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, list2, 5n], { account: f.daegu.account }),
      "VERSION_NOT_INCREASING",
    );
    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, list2, 4n], { account: f.daegu.account }),
      "VERSION_NOT_INCREASING",
    );
    // 저장값 유지
    let [encoded, version] = await f.statusListRegistry.read.get([LIST_ID]);
    assert.equal(encoded, list1);
    assert.equal(version, 5n);

    await f.statusListRegistry.write.publish([LIST_ID, list2, 6n], { account: f.daegu.account });
    [encoded, version] = await f.statusListRegistry.read.get([LIST_ID]);
    assert.equal(encoded, list2);
    assert.equal(version, 6n);
  });

  it("listId 는 서로 독립적이다", async () => {
    const f = await deployWithIssuers();
    await f.statusListRegistry.write.publish([LIST_ID, list1, 1n], { account: f.daegu.account });
    await f.statusListRegistry.write.publish(["dbp:status:imbank:list-1", list2, 1n], { account: f.imbank.account });
    const [, , , ownerA] = await f.statusListRegistry.read.get([LIST_ID]);
    const [, , , ownerB] = await f.statusListRegistry.read.get(["dbp:status:imbank:list-1"]);
    assert.equal(ownerA.toLowerCase(), f.daegu.account.address.toLowerCase());
    assert.equal(ownerB.toLowerCase(), f.imbank.account.address.toLowerCase());
  });

  it("미게시 listId 조회는 revert, 빈 목록은 거부", async () => {
    const f = await deployWithIssuers();
    await f.viem.assertions.revertWith(f.statusListRegistry.read.get(["dbp:status:none"]), "LIST_UNKNOWN");
    await f.viem.assertions.revertWith(
      f.statusListRegistry.write.publish([LIST_ID, "0x", 1n], { account: f.daegu.account }),
      "EMPTY_LIST",
    );
  });
});
