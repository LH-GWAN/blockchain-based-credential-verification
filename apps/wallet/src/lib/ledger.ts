/**
 * 공동원장 읽기 (viem). 지갑은 원장을 읽기만 한다 — ReceiptAnchor.anchoredAt(hash) 로 영수증 기록 시각을 확인.
 * 배포 정보(주소·ABI)는 발급기관 `/ledger/deployment` 가 공개하며, RPC 는 NEXT_PUBLIC_RPC_URL 을 쓴다.
 */
import { createPublicClient, http, type Abi, type Hex } from 'viem';
import type { LedgerDeployment } from './types';

export interface AnchorInfo {
  /** unix 초. 0 이면 미앵커. */
  anchoredAt: number;
}

export async function readAnchoredAt(deployment: LedgerDeployment, rpcUrl: string, saltedHash: string): Promise<AnchorInfo> {
  const c = deployment.contracts['ReceiptAnchor'];
  if (!c) throw new Error('ReceiptAnchor 배포 정보가 없습니다');
  if (!/^0x[0-9a-fA-F]{64}$/.test(saltedHash)) throw new Error('영수증 해시 형식이 올바르지 않습니다');
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) });
  const ts = await client.readContract({
    address: c.address as Hex,
    abi: c.abi as Abi,
    functionName: 'anchoredAt',
    args: [saltedHash as Hex],
  });
  return { anchoredAt: Number(ts as bigint) };
}
