// seed.ts 입력 점검 — 자리표시자 키·해시를 원장에 영구 등록하지 않도록 막는다(F56).
// 원장 등록은 되돌릴 수 없다: 발급기관 DID·번들 버전은 한 번 등록되면 같은 값으로 다시 쓸 수 없다.

export interface SeedInput {
  issuers: { did: string; name: string; ed25519PubKeyHex: string; controllerPrivateKey: string }[];
  bundles: { issuerDid: string; bundle: string; version: string; bundleHash: string; schemaHash: string }[];
  statusLists: { issuerDid: string; listId: string; encodedListBase64url: string; version: number }[];
}

/** 같은 바이트만 반복되는 32바이트 값(0xa1a1…, 0x0000…)은 예시 자리표시자로 본다. */
export function isPlaceholder32(hex: string): boolean {
  const h = hex.toLowerCase().replace(/^0x/, "");
  if (h.length !== 64) return false;
  return h === h.slice(0, 2).repeat(32);
}

/** 입력에 자리표시자가 있으면 항목 이름 목록을 돌려준다(빈 배열 = 통과). */
export function findPlaceholders(input: SeedInput): string[] {
  const bad: string[] = [];
  for (const it of input.issuers) {
    if (isPlaceholder32(it.ed25519PubKeyHex)) bad.push(`issuers[${it.did}].ed25519PubKeyHex`);
  }
  for (const b of input.bundles) {
    if (isPlaceholder32(b.bundleHash)) bad.push(`bundles[${b.bundle}@${b.version}].bundleHash`);
    if (isPlaceholder32(b.schemaHash)) bad.push(`bundles[${b.bundle}@${b.version}].schemaHash`);
  }
  return bad;
}

const norm = (v: string) => v.toLowerCase().replace(/^0x/, "");

/** 이미 등록된 값이 입력과 같은지 비교한다. 다르면 사람이 읽을 차이 목록을 돌려준다(빈 배열 = 같음). */
export function diffRegistered(label: string, onChain: Record<string, string>, wanted: Record<string, string>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of Object.entries(wanted)) {
    if (norm(onChain[k] ?? "") !== norm(v)) diffs.push(`${label}.${k}: 원장 ${onChain[k]} ≠ 입력 ${v}`);
  }
  return diffs;
}
