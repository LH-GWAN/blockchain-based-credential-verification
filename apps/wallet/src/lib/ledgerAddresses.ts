/**
 * 공동원장 컨트랙트 주소 찾기: 빌드 설정 → 단말에 저장된 값 → (허용할 때만) 발급기관 `/ledger/deployment`.
 * 주소는 공개 정보지만, 원장을 조회할 때마다 발급기관에 묻으면 "이 지갑이 지금 영수증을 확인한다" 는 신호가 남으므로
 * 발급기관 조회는 발급 화면처럼 어차피 발급기관과 통신하는 곳에서만 허용하고, 받은 값은 단말에 저장해 재사용한다 (F40).
 */
import { issuerApi } from './api';
import { ENV, ISSUERS } from './env';
import { hasAddresses, pickAddresses, type LedgerAddresses } from './ledger';
import { getCachedLedgerAddresses, setCachedLedgerAddresses } from './store';

export function addressesFromEnv(): LedgerAddresses {
  return pickAddresses({
    RuleRegistry: ENV.RULE_REGISTRY_ADDRESS,
    StatusListRegistry: ENV.STATUS_LIST_REGISTRY_ADDRESS,
    ReceiptAnchor: ENV.RECEIPT_ANCHOR_ADDRESS,
  });
}

export async function resolveLedgerAddresses(opts: { fetchFromIssuer: boolean }): Promise<LedgerAddresses | null> {
  const fromEnv = addressesFromEnv();
  if (hasAddresses(fromEnv)) return fromEnv;
  if (opts.fetchFromIssuer) {
    for (const iss of ISSUERS) {
      try {
        const d = await issuerApi.ledgerDeployment(iss.url);
        const picked = pickAddresses(d.contracts);
        if (hasAddresses(picked)) {
          await setCachedLedgerAddresses(picked).catch(() => undefined);
          return picked;
        }
      } catch {
        /* 다음 발급기관 */
      }
    }
  }
  const cached = await getCachedLedgerAddresses().catch(() => undefined);
  return hasAddresses(cached) ? cached : null;
}
