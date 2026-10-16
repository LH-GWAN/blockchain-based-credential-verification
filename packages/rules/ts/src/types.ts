/** JSON 값. 프로젝트 전체에서 부동소수점은 금지이며, 런타임(canonicalize / jsonlogic)에서 거부한다. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
/** JSON Logic 규칙: 연산자 객체 `{ op: args }` 또는 리터럴. */
export type Rule = Json;

/** preprocess.json 의 파생값 명세 (Python engine.preprocess 와 동일한 op 집합). */
export type DerivedStep =
  | { name: string; op: 'ageOn'; from: string }
  | { name: string; op: 'birthYear'; from: string }
  | { name: string; op: 'get'; path: string }
  | { name: string; op: 'clampInt'; from: string; min: number; max: number }
  | { name: string; op: 'lookup'; table: string; keyExpr: Rule }
  | { name: string; op: 'expr'; expr: Rule };

export interface PreprocessSpec {
  description?: string;
  evalDateEnv?: string;
  derived: DerivedStep[];
}

export interface ClaimsSpec {
  description?: string;
  issuerOf: Record<string, string>;
  labels: Record<string, string>;
  rules: Record<string, Rule>;
}

export interface PoliciesSpec {
  description?: string;
  rules: Record<string, Rule>;
}

/** data/median-income-2026.json 에서 파생되는 표. 필드를 바꾸면 Python bundle.compose_bundle 도 같이 고친다. */
export interface BundleTables {
  medianIncomeByHouseholdSize: Record<string, number>;
  basicPensionLineByHouseholdKind: { single: number; couple: number };
  medianIncomeSource: string;
  medianIncomeYear: number;
}

/** 규칙 번들 = { bundle, version, preprocess, claims, policies, tables }. 해시 = sha256(JCS(번들)). */
export interface Bundle {
  bundle: string;
  version: string;
  preprocess: PreprocessSpec;
  claims: ClaimsSpec;
  policies: PoliciesSpec;
  tables: BundleTables;
}

/** data/median-income-2026.json 중 번들 조합에 쓰는 부분. */
export interface MedianIncomeTable {
  year: number;
  source: string;
  byHouseholdSize: Record<string, number>;
  basicPension2026: { singleKRW: number; coupleKRW: number };
}

/** data/citizens.json 의 시민 프로필 (합성 데이터). type 별칭이라 JsonObject 로 바로 전달할 수 있다. */
export type CitizenProfile = {
  citizenId: string;
  name: string;
  birthDate: string;
  residence: { sido: string; sigungu: string };
  householdSize: number;
  monthlyIncomeKRW: number;
  isBasicLivelihoodRecipient: boolean;
  hasStudentChild: boolean;
  creditScoreTier: 'bottom20' | 'other';
  annualIncomeKRW: number;
  /** 세대주 여부 (주민등록, 대구시가 앎) */
  isHouseholdHead: boolean;
  /** 혼인 여부 (가족관계등록, 대구시가 앎) */
  isMarried: boolean;
  /** 재직 중 여부 = 직장 건강보험 가입 (복지기관이 건보 자격 연계로 앎) */
  isEmployed: boolean;
};

/** claim 이름 → 불리언 (원자적 사실). */
export type ClaimMap = Record<string, boolean>;
/** policyId → 적격 여부. */
export type PolicyMap = Record<string, boolean>;

/** AI 서비스에 전달 가능한 범주값. 원본 수치는 절대 포함하지 않는다. */
export interface CategoricalProfile {
  ageBand: '65+' | '<65';
  householdSize: number;
  residence: 'daegu' | 'other';
  incomeBracket: '≤32%' | '≤48%' | '≤50%' | '>50%';
  recipientStatus: 'recipient' | 'near-poor' | 'none';
  creditTier: 'bottom20' | 'other';
}
