/**
 * 창구 토큰 보관 (F03). POST /requests 응답의 counterToken 을 요청 ID 별로 sessionStorage 에 두고,
 * GET /results 에 X-Counter-Token 으로 보낸다 — 6자리 코드만 아는 제3자는 결과를 열람할 수 없다.
 * sessionStorage 는 탭 단위다: 요청을 만든 창구 탭에서만 결과를 볼 수 있다.
 * 저장소를 쓸 수 없으면(비공개 모드 등) 조용히 건너뛴다 — 결과 화면은 '권한 없음'으로 안내한다.
 */

export const COUNTER_TOKEN_PREFIX = "dbp-counter-token:";

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** "rid#replay-xxxxxx" 처럼 따로 기록된 제출의 키 → 원래 요청 ID. 토큰은 원래 요청에 하나뿐이다. */
export function baseRequestId(id: string): string {
  const i = id.indexOf("#");
  return i >= 0 ? id.slice(0, i) : id;
}

export function counterTokenKey(requestIdOrResultId: string): string {
  return `${COUNTER_TOKEN_PREFIX}${baseRequestId(requestIdOrResultId)}`;
}

function sessionStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveCounterToken(requestId: string, token: string | null | undefined, store: KeyValueStore | null = sessionStore()): void {
  if (!token || !store) return;
  try {
    store.setItem(counterTokenKey(requestId), token);
  } catch {
    /* 저장 불가 — 무시 */
  }
}

export function loadCounterToken(requestIdOrResultId: string, store: KeyValueStore | null = sessionStore()): string | null {
  if (!store) return null;
  try {
    return store.getItem(counterTokenKey(requestIdOrResultId));
  } catch {
    return null;
  }
}
