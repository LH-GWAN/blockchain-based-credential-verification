/**
 * 공동원장 읽기 (viem). 지갑은 원장을 읽기만 한다 — 쓰기 트랜잭션은 보내지 않는다.
 *  - RuleRegistry.getBundle(bundle, version): 규칙 번들 해시를 원장 등록값과 직접 대조 (F19)
 *  - StatusListRegistry.get(listId): 상태 목록 전체를 내려받아 내 증명서의 폐기 비트를 단말 안에서 확인 (F30)
 *  - ReceiptAnchor.anchoredAt(hash): 영수증이 원장에 기록된 시각
 * 컨트랙트 주소는 빌드 설정(NEXT_PUBLIC_*_ADDRESS) → 단말에 저장된 배포 정보 → 발급기관 `/ledger/deployment` 순으로 찾는다.
 * ABI 는 아래 최소 조각만 쓰므로 발급기관이 꺼져 있어도(⑦) 저장된 주소로 원장을 읽을 수 있다. RPC 는 NEXT_PUBLIC_RPC_URL.
 */
import { decodeStatusList, getStatus } from '@dbp/vc';
import { BaseError, ContractFunctionRevertedError, createPublicClient, hexToString, http, type Hex } from 'viem';

/** 원장 읽기 한 번의 상한. 원장이 멈춰도 화면이 오래 기다리지 않게 짧게, 재시도 없이. */
export const LEDGER_READ_TIMEOUT_MS = 4_000;

export interface LedgerAddresses {
  RuleRegistry?: string;
  StatusListRegistry?: string;
  ReceiptAnchor?: string;
}

const RULE_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getBundle',
    stateMutability: 'view',
    inputs: [
      { name: 'bundle', type: 'string' },
      { name: 'version', type: 'string' },
    ],
    outputs: [
      { name: 'bundleHash', type: 'bytes32' },
      { name: 'schemaHash', type: 'bytes32' },
      { name: 'by', type: 'address' },
      { name: 'at', type: 'uint64' },
    ],
  },
] as const;

const STATUS_LIST_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'listId', type: 'string' }],
    outputs: [
      { name: 'encodedList', type: 'bytes' },
      { name: 'version', type: 'uint64' },
      { name: 'updatedAt', type: 'uint64' },
      { name: 'owner', type: 'address' },
    ],
  },
] as const;

const RECEIPT_ANCHOR_ABI = [
  {
    type: 'function',
    name: 'anchoredAt',
    stateMutability: 'view',
    inputs: [{ name: 'saltedHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** 배포 정보(`/ledger/deployment` 의 contracts 또는 빌드 설정)에서 지갑이 읽는 세 컨트랙트 주소만 뽑는다. */
export function pickAddresses(contracts: Record<string, { address?: unknown } | string | undefined> | undefined): LedgerAddresses {
  const out: LedgerAddresses = {};
  if (!contracts) return out;
  for (const name of ['RuleRegistry', 'StatusListRegistry', 'ReceiptAnchor'] as const) {
    const c = contracts[name];
    const addr = typeof c === 'string' ? c : c?.address;
    if (typeof addr === 'string' && ADDRESS_RE.test(addr)) out[name] = addr;
  }
  return out;
}

export function hasAddresses(a: LedgerAddresses | undefined): a is LedgerAddresses {
  return !!a && (a.RuleRegistry !== undefined || a.StatusListRegistry !== undefined || a.ReceiptAnchor !== undefined);
}

function client(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl, { timeout: LEDGER_READ_TIMEOUT_MS, retryCount: 0 }) });
}

/** 컨트랙트가 revert 했는가 (= 원장은 응답했고 '없음'). 연결·시간 초과 오류와 구분한다. */
export function isRevert(e: unknown): boolean {
  if (e instanceof BaseError) return e.walk((x) => x instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
  return false;
}

export type LedgerBundle = { registered: true; bundleHash: string } | { registered: false };

/** RuleRegistry 에 등록된 번들 해시. 미등록(revert)이면 registered:false, 원장 연결 실패는 예외. */
export async function readBundleOnLedger(addresses: LedgerAddresses, rpcUrl: string, bundle: string, version: string): Promise<LedgerBundle> {
  if (!addresses.RuleRegistry) throw new Error('RuleRegistry 주소가 없습니다');
  try {
    const r = await client(rpcUrl).readContract({
      address: addresses.RuleRegistry as Hex,
      abi: RULE_REGISTRY_ABI,
      functionName: 'getBundle',
      args: [bundle, version],
    });
    return { registered: true, bundleHash: r[0] };
  } catch (e) {
    if (isRevert(e)) return { registered: false };
    throw e;
  }
}

/** StatusListRegistry 의 상태 목록 비트열 (목록 전체 — 어떤 인덱스를 보는지는 원장도 RPC 도 모른다). 미게시면 null. */
export async function readStatusList(addresses: LedgerAddresses, rpcUrl: string, listId: string): Promise<Uint8Array | null> {
  if (!addresses.StatusListRegistry) throw new Error('StatusListRegistry 주소가 없습니다');
  try {
    const r = await client(rpcUrl).readContract({
      address: addresses.StatusListRegistry as Hex,
      abi: STATUS_LIST_REGISTRY_ABI,
      functionName: 'get',
      args: [listId],
    });
    return decodeStatusList(hexToString(r[0]));
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

/** 비트열에서 폐기 여부. 인덱스가 범위를 벗어나면 null (판단 불가). */
export function revokedIn(list: Uint8Array, index: number): boolean | null {
  try {
    return getStatus(list, index);
  } catch {
    return null;
  }
}

export interface AnchorInfo {
  /** unix 초. 0 이면 미앵커. */
  anchoredAt: number;
}

export async function readAnchoredAt(addresses: LedgerAddresses, rpcUrl: string, saltedHash: string): Promise<AnchorInfo> {
  if (!addresses.ReceiptAnchor) throw new Error('ReceiptAnchor 배포 정보가 없습니다');
  if (!/^0x[0-9a-fA-F]{64}$/.test(saltedHash)) throw new Error('영수증 해시 형식이 올바르지 않습니다');
  const ts = await client(rpcUrl).readContract({
    address: addresses.ReceiptAnchor as Hex,
    abi: RECEIPT_ANCHOR_ABI,
    functionName: 'anchoredAt',
    args: [saltedHash as Hex],
  });
  return { anchoredAt: Number(ts) };
}
