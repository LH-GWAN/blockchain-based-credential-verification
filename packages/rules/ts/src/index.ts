/**
 * @dbp/rules — 대구 혜택패스 규칙 엔진 (브라우저·Node 공통, Node 전용 import 없음).
 * Python `dbp_rules` 와 평가 의미·번들 해시가 동일하다. 파일 로딩은 '@dbp/rules/node' 에 있다.
 */
export { evaluate, SUPPORTED } from './jsonlogic.js';
export { canonicalize, sha256Hex } from './canonical.js';
export { composeBundle, bundleHash, schemaHash } from './bundle.js';
export {
  DEFAULT_EVAL_DATE,
  toYmd,
  preprocess,
  evaluateClaims,
  evaluatePolicies,
  categoricalProfile,
  type DateLike,
  type Ymd,
} from './engine.js';
export { policyIndex, type PolicyMeta, type LegalBasis, type RequiredClaim } from './policies.js';
export type {
  Json,
  JsonObject,
  Rule,
  Bundle,
  BundleTables,
  PreprocessSpec,
  DerivedStep,
  ClaimsSpec,
  PoliciesSpec,
  MedianIncomeTable,
  CitizenProfile,
  ClaimMap,
  PolicyMap,
  CategoricalProfile,
} from './types.js';
