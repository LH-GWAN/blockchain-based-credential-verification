/**
 * @dbp/vc — VC/VP 생성·서명·검증, did:key, JCS 해시, Bitstring Status List, 영수증 해시.
 * 브라우저·Node 공통 (Node 전용 import 없음). Python `dbp_vc`와 동작이 동일하다.
 */
export { VcError } from './errors.js';
export { ed25519PublicKey, ed25519PublicKeyHex, ed25519Sign, ed25519Verify } from './ed25519.js';
export { generateHolderKey, didKeyToPublicKey, publicKeyToDidKey, type HolderKey } from './didkey.js';
export { canonicalize, sha256Hex, bundleHash } from './jcs.js';
export { signJws, verifyJws, decodeJws, type JwsHeader, type DecodedJws } from './jws.js';
export { isoToSeconds, dateToSeconds } from './time.js';
export {
  issueVc,
  decodeVc,
  verifyVc,
  VC_CONTEXT,
  VC_TYPE,
  VC_SCHEMA,
  VC_JWT_TYP,
  type AtomicVc,
  type VcJwtPayload,
  type IssueVcParams,
  type VcChecks,
} from './vc.js';
export { createVp, verifyVp, VP_JWT_TYP, type VpJwtPayload, type CreateVpParams } from './vp.js';
export {
  createStatusList,
  setStatus,
  getStatus,
  encodeStatusList,
  decodeStatusList,
  DEFAULT_STATUS_LIST_SIZE,
} from './statuslist.js';
export { receiptHash, randomSalt, randomNonce } from './receipt.js';
