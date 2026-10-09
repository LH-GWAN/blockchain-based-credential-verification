/** 화면에 노출되는 한국어 문구. 전문용어 금지(§12.1): VC→자격 증명서, VP→제출, nonce→1회용 확인번호. */
import type { AttackKind, CheckKey, Preset, TimingPart } from "./types";

/** 원장에 등록된 판정 규칙 버전. 헤더 배지·정책 판정 카드에 표시한다. */
export const RULES_VERSION = "v2026.2";

export const HEADER = {
  title: "검증기관 화면",
  subtitle: "발급기관에 직접 조회하지 않습니다 · 공동원장만 확인",
  tagline: "소득금액증명 원본 대신 참/거짓 항목만 받습니다",
  badgeLedger: "검증: 공동원장",
  badgeRules: `판정 규칙: ${RULES_VERSION}`,
  product: "대구 혜택패스",
} as const;

export const HEALTH = {
  checking: "연결 확인 중…",
  ok: "검증 서비스 연결됨",
  down: "검증 서비스에 연결할 수 없습니다",
  ledgerOn: "원장 연결됨",
  ledgerOff: "원장 미연결",
} as const;

export const STEPS = [
  { href: "/", label: "요청 만들기", match: (p: string) => p === "/" },
  { href: null, label: "결과", match: (p: string) => p.startsWith("/result") },
  { href: "/attack", label: "공격 시연", match: (p: string) => p.startsWith("/attack") },
] as const;

export const ERRORS = {
  unavailable: "검증 서비스에 연결할 수 없습니다",
  unavailableHint: (url: string) => `검증 서비스(${url})가 실행 중인지 확인한 뒤 다시 시도하세요. \`make demo\` 로 전체 스택을 올릴 수 있습니다.`,
  retry: "다시 시도",
  requestUnknown: "요청을 찾을 수 없습니다",
  requestUnknownHint: "검증 서비스가 재시작되었을 수 있습니다. 새 요청을 만들어 주세요.",
  generic: (code: string) => `오류가 발생했습니다 (${code})`,
} as const;

export const REQUEST = {
  title: "검증 요청 만들기",
  lead: "창구(기관)·용도·요청 항목을 정하면 1회용 확인번호가 담긴 QR 이 만들어집니다. 시민 지갑은 소득 금액 대신 참/거짓 항목만 서명해 제출합니다.",
  verifier: "창구(기관)",
  presets: "용도 프리셋",
  presetsLead: "프리셋을 누르면 용도·요청 항목·정책 판정이 한 번에 채워집니다. 이후 직접 바꿔도 됩니다.",
  presetCustom: "직접 설정 중 — 정책 판정 없이 요청 항목의 참/거짓만 확인합니다.",
  presetPolicy: "정책 판정",
  /** 프리셋 counterChecked — 증명서로 받지 않으므로 창구가 요청 전에 직접 조회해 두어야 하는 항목. */
  presetCounterChecked: (items: string) => `창구가 먼저 확인: ${items}`,
  purpose: "용도",
  purposeDefault: "서민금융 상담 대상 확인",
  claims: "요청 항목",
  claimsHint: "체크한 항목의 '충족 여부(참)'만 요청합니다. 항목을 바꾸면 프리셋 선택이 해제됩니다.",
  submit: "요청 QR 만들기",
  creating: "요청 생성 중…",
  needOne: "요청 항목을 하나 이상 선택하세요",
  qrTitle: "지갑에서 QR 을 스캔하거나",
  codeTitle: "지갑에서 이 번호를 입력하세요",
  remaining: "남은 시간",
  expired: "만료됨",
  expiredHint: "요청이 만료되었습니다. 새 요청을 만들어 주세요.",
  newRequest: "새 요청",
  changeSettings: "설정 바꾸기",
  waiting: "지갑의 제출을 기다리는 중…",
  requestedItems: "요청 항목",
  notRequested: "요청하지 않는 정보: 이름 · 주민등록번호 · 주소 · 소득 금액 · 계좌 정보",
  requestId: "요청 ID",
  verifierLabel: "창구(기관)",
  purposeLabel: "용도",
} as const;

/**
 * GET /presets 가 실패했을 때 쓰는 내장 사본. services/verifier/src/dbp_verifier/config.py 의 PRESETS 와 동일하게 유지한다
 * (ID·문구·요청 항목·정책 ID·힌트·취급 창구 종류·창구 자체 확인 항목까지). 은행·저축은행 창구에서 실제로 쓰이는 용도만 둔다.
 * verifierKinds: 그 상품을 실제로 취급하는 창구 종류. 새희망홀씨는 은행권 상품이라 저축은행에는 없다.
 * counterChecked: 증명서로 받지 않고 창구가 먼저 자체 조회한 항목(신용평점). 정책 판정 재현에 창구 확인값으로 들어간다.
 */
export const PRESETS_FALLBACK: readonly Preset[] = [
  {
    id: "consult",
    label: "서민금융 상담 대상 확인",
    purpose: "서민금융 상담 대상 확인",
    requested: [
      { claim: "daeguResident", expected: true },
      { claim: "incomeBelow50Median", expected: true },
    ],
    policyId: null,
    verifierKinds: ["bank", "savings"],
    hint: "대구 거주 여부와 기준 중위소득 50% 이하 여부, 두 항목의 참/거짓만 받습니다.",
  },
  {
    id: "sunshine-general",
    label: "햇살론 일반보증 대상 확인",
    purpose: "햇살론 일반보증 대상 확인",
    requested: [{ claim: "annualIncomeUnder35M", expected: true }],
    policyId: "sunshine-loan-general",
    verifierKinds: ["bank", "savings"],
    hint: "소득금액증명 원본 대신 '연소득 3,500만 원 이하 = 참' 1개 항목만 받습니다. 신용평점·재직(사업) 기간·보증 심사용 소득 증빙은 창구가 자체 확인합니다. 2026년 개편으로 은행·저축은행 모두 취급합니다.",
  },
  {
    id: "sunshine-general-low-credit",
    label: "햇살론 일반보증 · 신용 하위 20% 고객",
    purpose: "햇살론 일반보증 대상 확인 (신용평점 하위 20%)",
    requested: [{ claim: "annualIncomeUnder45M", expected: true }],
    policyId: "sunshine-loan-general",
    verifierKinds: ["bank", "savings"],
    counterChecked: [{ claim: "creditBottom20", expected: true }],
    hint: "창구 조회로 신용평점 하위 20%인 고객: 소득금액증명 원본 대신 '연소득 4,500만 원 이하 = 참' 1개 항목만 받습니다. 재직(사업) 기간·보증 심사용 소득 증빙은 창구가 자체 확인합니다.",
  },
  {
    id: "new-hope",
    label: "새희망홀씨 대상 확인",
    purpose: "새희망홀씨 대상 확인",
    requested: [{ claim: "annualIncomeUnder40M", expected: true }],
    policyId: "new-hope-loan",
    verifierKinds: ["bank"],
    hint: "소득금액증명 원본 대신 '연소득 4,000만 원 이하 = 참' 1개 항목만 받습니다. 신용평점·재직 등 대출 심사는 은행이 자체 확인합니다. 은행권 상품이라 저축은행 창구에는 없습니다.",
  },
  {
    id: "new-hope-low-credit",
    label: "새희망홀씨 · 신용 하위 20% 고객",
    purpose: "새희망홀씨 대상 확인 (신용평점 하위 20%)",
    requested: [{ claim: "annualIncomeUnder50M", expected: true }],
    policyId: "new-hope-loan",
    verifierKinds: ["bank"],
    counterChecked: [{ claim: "creditBottom20", expected: true }],
    hint: "은행 조회로 신용평점 하위 20%인 고객: 소득금액증명 원본 대신 '연소득 5,000만 원 이하 = 참' 1개 항목만 받습니다. 재직 등 대출 심사는 은행이 자체 확인합니다.",
  },
  {
    id: "discount",
    label: "공공요금 감면 대상 확인",
    purpose: "공공요금 감면 대상 확인",
    requested: [{ claim: "incomeBelow50Median", expected: true }],
    policyId: null,
    verifierKinds: ["bank", "savings"],
    hint: "전기·도시가스·통신 요금 감면 창구가 수급자증명서 원본 대신 '기준 중위소득 50% 이하 = 참' 1개 항목만 받습니다.",
  },
];

/** 창구 종류(kind) → 문구. 검증기관은 금융 창구뿐이다. 모르는 종류는 '금융기관'. */
export const VERIFIER_KIND_LABELS: Record<string, string> = {
  bank: "은행",
  savings: "저축은행",
};

export function verifierKindLabel(kind: string | null | undefined): string {
  return (kind && VERIFIER_KIND_LABELS[kind]) || "금융기관";
}

/** 정책 ID → 이름. data/policies/*.json 의 name 과 동일. */
export const POLICY_LABELS: Record<string, string> = {
  "sunshine-loan-general": "햇살론 일반보증",
  "new-hope-loan": "새희망홀씨",
  "micro-livelihood-loan": "소액생계비대출",
  "nbl-livelihood": "생계급여",
  "nbl-housing": "주거급여",
  "nbl-education": "교육급여",
  "near-poor": "차상위계층 확인",
  "basic-pension": "기초연금",
  "energy-voucher": "에너지바우처",
  "telecom-discount": "통신요금 감면",
  "daegu-metro-free": "대구 어르신 통합무임 교통카드",
  "electricity-welfare-discount": "전기요금 복지할인",
  "city-gas-discount": "도시가스 요금 경감",
};

export function policyLabel(policyId: string): string {
  return POLICY_LABELS[policyId] ?? policyId;
}

export const RESULT = {
  pass: "자격 충족",
  fail: "자격 미충족",
  pending: "결과를 기다리는 중…",
  pendingHint: "시민 지갑이 제출하면 이 화면이 자동으로 갱신됩니다.",
  pendingExpired: "제출 없이 요청이 만료되었습니다",
  verifier: "검증기관",
  purpose: "용도",
  issuer: "발급기관",
  status: "상태",
  holder: "제출자",
  verifiedAt: "검증 시각",
  claimsTable: "요청 항목 확인",
  colClaim: "항목",
  colResult: "결과",
  colIssuer: "발급기관",
  notPresented: "미제출",
  checklist: "검증 단계",
  checklistHint: "모든 확인은 전자서명과 공동원장 조회만으로 이뤄집니다. 발급기관 서버에는 묻지 않습니다.",
  timing: "소요 시간",
  total: (sec: string) => `총 소요 ${sec}`,
  reasons: "차단 사유",
  reasonCodes: "사유 코드",
  receipt: "제출 영수증",
  receiptHash: "제출 영수증 해시",
  receiptTx: "원장 트랜잭션",
  receiptRecording: "기록 중…",
  receiptUnavailable: "원장 기록을 확인하지 못했습니다 (원장 미연결 또는 지연)",
  receiptObject: "영수증 원문 (JSON)",
  receiptNote: "영수증에는 제출물의 해시·기관 DID·1회용 확인번호·솔트만 담깁니다. 개인정보는 없습니다.",
  credentials: "증명서별 상세",
  credClaim: "항목",
  credValue: "값",
  credIssuer: "발급기관",
  credIndex: "상태목록 번호",
  credListVersion: "상태목록 버전",
  credRule: "규칙 버전",
  credId: "증명서 ID",
  credChecks: "확인",
  dataNote: (n: number) => `기관이 받은 것: 참/거짓 항목 ${n}개 + 발급기관 + 유효상태. 이름·소득 금액·주민번호는 받지 않았습니다.`,
  policyCheck: "정책 판정 재현",
  /** 창구 확인값(신용평점)이 판정에 들어갔으면 그렇다고 적는다 — '신용평점은 포함하지 않음'과 엇갈리지 않게. */
  policyRuleNote: (withCounterChecked = false) =>
    withCounterChecked
      ? `규칙 ${RULES_VERSION}, 제출된 항목과 창구 확인값만으로 계산 — 재직 등 그 밖의 창구 심사 요건은 포함하지 않음`
      : `규칙 ${RULES_VERSION}, 제출된 항목만으로 계산 — 재직·신용평점 등 창구 심사 요건은 포함하지 않음`,
  eligible: "적격",
  ineligible: "부적격",
  undetermined: "판정 불가",
  /** 판정 불가 사유: 결과를 바꾸는(제출되지 않은) 항목. 제출되지 않은 항목을 거짓으로 채우지 않는다. */
  policyPending: (labels: string) => `판정에 필요한 항목이 제출되지 않았습니다: ${labels}`,
  /** 증명서가 아니라 창구가 자체 조회해 판정에 넣은 항목(신용평점). */
  policyCounterChecked: (labels: string) => `창구 자체 확인: ${labels}`,
  /** 판정 불가 사유 중 시민이 제출할 수 없고 창구가 조회해야 하는 항목(신용평점). */
  policyNeedsCounter: (labels: string) => `창구 확인이 필요한 항목: ${labels}`,
  newRequest: "새 요청",
  toAttack: "공격 시연으로",
  copy: "복사",
  copied: "복사됨",
  yes: "참",
  no: "거짓",
} as const;

export const COMPARISON = {
  title: "같은 상담, 두 경로 비교",
  lead: "이번 용도로 창구가 자격을 확인하는 두 가지 방법. 왼쪽은 원문을 끌어오는 조회형, 오른쪽은 시민이 보유한 참·거짓을 제출하는 보유형.",
  pullTitle: "공공 마이데이터 방식 (조회형)",
  holdTitle: "대구 혜택패스 (보유형)",
  pullDocs: "넘어오는 서류",
  pullItems: "창구가 받게 되는 항목",
  holdItems: "이번에 실제로 받은 것",
  itemsBadge: (n: number) => `${n}개 항목`,
  recordsLabel: "남는 기록",
  reduced: "이번 검증에서 줄어든 항목",
  sourceLabel: "서식 출처",
} as const;

export const CHECK_LABELS: Record<CheckKey, string> = {
  nonce: "1회용 확인번호",
  vpSignature: "제출 서명",
  issuerOnLedger: "발급기관 원장 등록",
  vcSignature: "증명서 서명",
  notRevoked: "폐기 여부",
  ruleVersion: "규칙 버전 일치",
  holderBinding: "소유자 일치",
  requestedClaims: "요청 항목 충족",
};

/** 증명서별 checks 키 → 문구 */
export const CRED_CHECK_LABELS: Record<string, string> = {
  issuerRegistered: "발급기관 원장 등록",
  issuerActive: "발급기관 활성",
  signature: "증명서 서명",
  holderBinding: "소유자 일치",
  notRevoked: "폐기 여부",
  ruleVersion: "규칙 버전 일치",
};

export const TIMING_LABELS: Record<TimingPart, string> = {
  parse: "파싱",
  nonce: "1회용 번호",
  vpSignature: "제출 서명",
  credentials: "증명서·원장 조회",
  claims: "항목 대조",
};

export const ATTACK = {
  title: "공격 시연",
  lead: "마지막으로 성공한 제출을 변조해 다시 보냅니다. 각 공격이 어떤 단계에서 어떤 사유로 차단되는지 확인하세요.",
  needPrior: "먼저 정상 제출을 한 번 완료하세요",
  needPriorHint: "요청 QR 을 만들고 시민 지갑에서 제출한 뒤 다시 시도하세요.",
  goHome: "요청 만들기로",
  running: "제출 중…",
  blocked: "차단됨",
  notBlocked: "차단되지 않음 — 예상과 다릅니다",
  expectedCode: "예상 사유 코드",
  run: "실행",
  rerun: "다시 실행",
  kinds: {
    replay: {
      label: "재사용 제출",
      what: "같은 1회용 확인번호로 두 번 제출",
      explain: "같은 1회용 확인번호로 두 번 제출 → 검증기관이 '이미 사용됨'을 확인 → NONCE_REUSED",
      expected: "NONCE_REUSED",
    },
    expired: {
      label: "만료된 요청",
      what: "만료 시각이 지난 요청에 제출",
      explain: "요청의 만료 시각을 지나서 제출 → 1회용 확인번호 유효시간 초과 → NONCE_EXPIRED",
      expected: "NONCE_EXPIRED",
    },
    forged: {
      label: "위조된 증명서",
      what: "증명서 서명을 변조해 제출",
      explain: "증명서 서명 바이트를 바꿔 제출 → 원장의 발급기관 공개키로 서명 검증 실패 → VC_SIG_INVALID",
      expected: "VC_SIG_INVALID",
    },
    "wrong-holder": {
      label: "타인 증명서 도용",
      what: "다른 지갑 키로 남의 증명서를 제출",
      explain: "다른 사람의 증명서를 내 지갑 키로 서명해 제출 → 증명서 소유자와 제출자가 다름 → HOLDER_MISMATCH",
      expected: "HOLDER_MISMATCH",
    },
  } satisfies Record<AttackKind, { label: string; what: string; explain: string; expected: string }>,
} as const;

/** 서버 REASON_KO 의 폴백(응답에 reasons 가 없을 때만 사용). services/verifier/config.py 와 동일하게 유지. */
export const REASON_KO: Record<string, string> = {
  AUD_MISMATCH: "다른 기관에 제출된 증명입니다",
  NONCE_MISSING: "1회용 확인번호가 없습니다",
  NONCE_UNKNOWN: "알 수 없는 검증 요청입니다",
  NONCE_EXPIRED: "검증 요청 시간이 만료되었습니다",
  NONCE_REUSED: "이미 사용된 제출입니다 (재사용 차단)",
  VP_SIG_INVALID: "제출 서명이 올바르지 않습니다",
  ISSUER_UNKNOWN: "원장에 등록되지 않은 발급기관입니다",
  ISSUER_INACTIVE: "정지된 발급기관입니다",
  VC_SIG_INVALID: "증명서 서명이 위조·변조되었습니다",
  EXPIRED: "증명서 유효기간이 지났습니다",
  NOT_YET_VALID: "아직 유효하지 않은 증명서입니다",
  HOLDER_MISMATCH: "제출자가 증명서의 소유자가 아닙니다",
  REVOKED: "폐기된 증명서입니다",
  RULE_HASH_MISMATCH: "판정에 사용된 규칙 버전이 원장과 다릅니다",
  STATUS_LIST_UNAVAILABLE: "원장에서 상태 목록을 찾을 수 없습니다",
  CLAIM_MISSING: "요청한 항목의 증명서가 없습니다",
  CLAIM_FALSE: "요청한 항목이 충족되지 않았습니다",
  VP_MALFORMED: "제출 형식이 올바르지 않습니다",
  PRESET_NOT_OFFERED: "이 창구에서 취급하지 않는 상품입니다",
  POLICY_UNKNOWN: "규칙 묶음에 없는 정책입니다",
};

export function reasonText(code: string, fromServer?: string): string {
  return fromServer ?? REASON_KO[code] ?? code;
}

/** 요청 생성 실패(4xx detail 코드) → 화면 문구. 아는 코드(예: PRESET_NOT_OFFERED)는 한국어로, 그 외는 코드를 붙인 일반 오류. */
export function requestErrorText(code: string): string {
  return REASON_KO[code] ?? ERRORS.generic(code);
}

/** claim 키 → 문구 폴백 (서버 응답의 label 이 우선). packages/rules/bundles/daegu-eligibility/2026.2/claims.json 과 동일. */
export const CLAIM_LABELS: Record<string, string> = {
  daeguResident: "대구 거주 여부",
  ageOver65: "65세 이상 여부",
  daeguMetroFreeAge: "도시철도 무임 연령(1958년생 이전) 여부",
  singlePersonHousehold: "1인 가구 여부",
  hasStudentChild: "초·중·고 학생 자녀 유무",
  isBenefitRecipient: "기초생활보장 급여 수급 여부",
  incomeBelow32Median: "기준 중위소득 32% 이하 여부",
  incomeBelow48Median: "기준 중위소득 48% 이하 여부",
  incomeBelow50Median: "기준 중위소득 50% 이하 여부",
  incomeBelowBasicPensionLine: "기초연금 선정기준액 이하 여부",
  creditBottom20: "신용평점 하위 20% 여부",
  annualIncomeUnder35M: "연소득 3,500만 원 이하 여부",
  annualIncomeUnder40M: "연소득 4,000만 원 이하 여부",
  annualIncomeUnder45M: "연소득 4,500만 원 이하 여부",
  annualIncomeUnder50M: "연소득 5,000만 원 이하 여부",
};

export function claimLabel(claim: string, fromServer?: string): string {
  return fromServer ?? CLAIM_LABELS[claim] ?? claim;
}
