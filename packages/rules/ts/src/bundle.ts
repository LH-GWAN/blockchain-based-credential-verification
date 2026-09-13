/**
 * 규칙 번들 조합과 해시. Python `dbp_rules.bundle` 과 같은 객체를 만든다 —
 * 여기서 필드를 추가·삭제하면 양쪽을 같이 고친다.
 */
import { canonicalize, sha256Hex } from './canonical.js';
import type { Bundle, ClaimsSpec, MedianIncomeTable, PoliciesSpec, PreprocessSpec } from './types.js';
import { toInt } from './util.js';

export function composeBundle(
  bundle: string,
  version: string,
  preprocess: PreprocessSpec,
  claims: ClaimsSpec,
  policies: PoliciesSpec,
  medianIncome: MedianIncomeTable,
): Bundle {
  const tables = {
    medianIncomeByHouseholdSize: Object.fromEntries(
      Object.entries(medianIncome.byHouseholdSize).map(([k, v]) => [k, toInt(v)]),
    ),
    basicPensionLineByHouseholdKind: {
      single: toInt(medianIncome.basicPension2026.singleKRW),
      couple: toInt(medianIncome.basicPension2026.coupleKRW),
    },
    medianIncomeSource: medianIncome.source,
    medianIncomeYear: toInt(medianIncome.year),
  };
  return { bundle, version, preprocess, claims, policies, tables };
}

/** 번들 해시 = '0x' + sha256(JCS(번들)). RuleRegistry 등록값과 동일. */
export function bundleHash(b: object): string {
  return '0x' + sha256Hex(canonicalize(b));
}

/** 원자적 claim VC 스키마 식별자의 해시 (스키마 자체는 packages/vc 가 고정). */
export function schemaHash(): string {
  return '0x' + sha256Hex(canonicalize({
    id: 'dbp:schema:atomic-claim:1',
    type: 'JsonSchema',
    subject: { id: 'did', '<claim>': 'boolean' },
  }));
}
