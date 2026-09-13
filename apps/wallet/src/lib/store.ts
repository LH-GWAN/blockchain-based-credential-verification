/**
 * 지갑 로컬 저장소 (IndexedDB, idb-keyval). 이 파일의 값은 단말 밖으로 나가지 않는다.
 * SSR 프리렌더 중에는 indexedDB 가 없으므로 스토어를 지연 생성한다.
 */
import { clear, createStore, get, set, type UseStore } from 'idb-keyval';
import type { Bundle, ConsentReceiptRecord, PolicyMeta, PresentationRecord, StoredCredential, WalletRecord } from './types';

const KEYS = {
  wallet: 'wallet',
  credentials: 'credentials',
  consents: 'consentReceipts',
  presentations: 'presentationReceipts',
  bundle: 'ruleBundle',
  policies: 'policies',
} as const;

let _store: UseStore | undefined;
function db(): UseStore {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB 를 사용할 수 없는 환경입니다');
  if (!_store) _store = createStore('dbp-wallet', 'kv');
  return _store;
}

async function read<T>(key: string, fallback: T): Promise<T> {
  const v = await get<T>(key, db());
  return v === undefined ? fallback : v;
}

// ---------- 지갑 키 ----------

export function getWallet(): Promise<WalletRecord | undefined> {
  return get<WalletRecord>(KEYS.wallet, db());
}

export function saveWallet(w: WalletRecord): Promise<void> {
  return set(KEYS.wallet, w, db());
}

/** 설정 → 지갑 초기화: 키·증명서·영수증·캐시 전부 삭제. */
export function resetWallet(): Promise<void> {
  return clear(db());
}

// ---------- 자격 증명서 ----------

export function getCredentials(): Promise<StoredCredential[]> {
  return read<StoredCredential[]>(KEYS.credentials, []);
}

/** jti 기준 병합. 같은 claim 을 다시 발급받으면 최신 것으로 교체한다. */
export async function addCredentials(list: StoredCredential[]): Promise<StoredCredential[]> {
  const cur = await getCredentials();
  const byClaim = new Map<string, StoredCredential>();
  for (const c of cur) byClaim.set(`${c.issuerDid}:${c.claim}`, c);
  for (const c of list) byClaim.set(`${c.issuerDid}:${c.claim}`, c);
  const merged = [...byClaim.values()].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  await set(KEYS.credentials, merged, db());
  return merged;
}

// ---------- 영수증 ----------

export function getConsentReceipts(): Promise<ConsentReceiptRecord[]> {
  return read<ConsentReceiptRecord[]>(KEYS.consents, []);
}

export async function addConsentReceipt(r: ConsentReceiptRecord): Promise<void> {
  const cur = await getConsentReceipts();
  await set(KEYS.consents, [...cur, r], db());
}

export function getPresentations(): Promise<PresentationRecord[]> {
  return read<PresentationRecord[]>(KEYS.presentations, []);
}

export async function addPresentation(r: PresentationRecord): Promise<void> {
  const cur = await getPresentations();
  await set(KEYS.presentations, [...cur.filter((x) => x.requestId !== r.requestId), r], db());
}

export async function updatePresentation(requestId: string, patch: Partial<PresentationRecord>): Promise<void> {
  const cur = await getPresentations();
  await set(
    KEYS.presentations,
    cur.map((x) => (x.requestId === requestId ? { ...x, ...patch } : x)),
    db(),
  );
}

// ---------- 규칙 번들·정책 캐시 (발급기관이 꺼져 있어도 판정·제출이 가능하도록) ----------

export function getCachedBundle(): Promise<Bundle | undefined> {
  return get<Bundle>(KEYS.bundle, db());
}

export function setCachedBundle(b: Bundle): Promise<void> {
  return set(KEYS.bundle, b, db());
}

export function getCachedPolicies(): Promise<PolicyMeta[] | undefined> {
  return get<PolicyMeta[]>(KEYS.policies, db());
}

export function setCachedPolicies(p: PolicyMeta[]): Promise<void> {
  return set(KEYS.policies, p, db());
}
