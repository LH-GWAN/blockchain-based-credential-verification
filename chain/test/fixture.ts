// 테스트 공용 픽스처: 인프로세스 Hardhat 네트워크에 4개 컨트랙트를 새로 배포한다.
// (network.create() 는 호출마다 새 시뮬레이터 인스턴스를 만들므로 테스트 간 상태가 격리된다)
import { network } from "hardhat";
import { keccak256, stringToHex } from "viem";

// Ed25519 공개키 자리표시자 — 실제 키가 아니라 결정론적 32바이트 값
export const DAEGU = {
  did: "did:dbp:daegu",
  name: "대구광역시",
  pubKey: keccak256(stringToHex("test-ed25519-daegu")),
};
export const IMBANK = {
  did: "did:dbp:imbank",
  name: "iM뱅크",
  pubKey: keccak256(stringToHex("test-ed25519-imbank")),
};

export async function deployAll() {
  const { viem } = await network.create();
  const [governance, daegu, imbank, stranger] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const issuerRegistry = await viem.deployContract("IssuerRegistry");
  const ruleRegistry = await viem.deployContract("RuleRegistry", [issuerRegistry.address]);
  const statusListRegistry = await viem.deployContract("StatusListRegistry", [issuerRegistry.address]);
  const receiptAnchor = await viem.deployContract("ReceiptAnchor");

  return {
    viem,
    publicClient,
    governance,
    daegu,
    imbank,
    stranger,
    issuerRegistry,
    ruleRegistry,
    statusListRegistry,
    receiptAnchor,
  };
}

export type Fixture = Awaited<ReturnType<typeof deployAll>>;

/** 거버넌스가 발급기관 2곳(daegu: 계정#1, imbank: 계정#2)을 등록한 상태로 만든다. */
export async function deployWithIssuers() {
  const f = await deployAll();
  await f.issuerRegistry.write.register([DAEGU.did, DAEGU.pubKey, DAEGU.name, f.daegu.account.address]);
  await f.issuerRegistry.write.register([IMBANK.did, IMBANK.pubKey, IMBANK.name, f.imbank.account.address]);
  return f;
}
