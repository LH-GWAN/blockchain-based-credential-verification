/**
 * 네트워크 계층 (fetch 를 가짜로 바꿔 확인):
 *  - F19·F30 viem 원장 읽기: 등록값·미등록(revert)·연결 실패를 구분한다
 *  - F34 결과 조회는 X-Vp-Hash 헤더로, F20 세션 삭제는 본문 없는 keepalive DELETE, F12 감사 기록은 auditId 로
 *  - F18 AI 호출 시간 제한은 서버 LLM 포기 시간(25초)보다 길다
 */
import { createStatusList, encodeStatusList, setStatus } from '@dbp/vc';
import { encodeErrorResult, encodeFunctionResult, stringToHex, type Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_TIMEOUT_MS, PRESENT_TIMEOUT_MS, aiApi, verifierApi } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { readAnchoredAt, readBundleOnLedger, readStatusList, revokedIn } from '@/lib/ledger';

const ADDR = {
  RuleRegistry: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  StatusListRegistry: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  ReceiptAnchor: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
};
const RPC = 'http://ledger.test:8545';
const HASH = `0x${'ab'.repeat(32)}` as const;
const ZERO32 = `0x${'00'.repeat(32)}` as const;

const GET_BUNDLE_ABI = [
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
] as const satisfies Abi;
const GET_LIST_ABI = [
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
] as const satisfies Abi;
const ERROR_ABI = [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }] as const satisfies Abi;

/** eth_call 에 정해진 result(또는 revert) 로 답하는 가짜 JSON-RPC. */
function rpc(answer: { result?: string; revert?: string }) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string };
    const body =
      answer.revert !== undefined
        ? {
            jsonrpc: '2.0',
            id: req.id,
            error: {
              code: 3,
              message: `execution reverted: ${answer.revert}`,
              data: encodeErrorResult({ abi: ERROR_ABI, errorName: 'Error', args: [answer.revert] }),
            },
          }
        : { jsonrpc: '2.0', id: req.id, result: answer.result };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('F19 RuleRegistry 읽기', () => {
  it('등록된 번들 해시를 돌려준다', async () => {
    const result = encodeFunctionResult({
      abi: GET_BUNDLE_ABI,
      functionName: 'getBundle',
      result: [HASH, ZERO32, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1760000000n],
    });
    vi.stubGlobal('fetch', rpc({ result }));
    await expect(readBundleOnLedger(ADDR, RPC, 'daegu-eligibility', '2026.2')).resolves.toEqual({ registered: true, bundleHash: HASH });
  });
  it('revert(BUNDLE_UNKNOWN) 는 미등록으로 — 연결 오류와 다르다', async () => {
    vi.stubGlobal('fetch', rpc({ revert: 'BUNDLE_UNKNOWN' }));
    await expect(readBundleOnLedger(ADDR, RPC, 'daegu-eligibility', '2099.1')).resolves.toEqual({ registered: false });
  });
  it('원장 연결 실패는 예외 (화면은 발급기관 선언값으로만 대조)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(readBundleOnLedger(ADDR, RPC, 'daegu-eligibility', '2026.2')).rejects.toBeTruthy();
  });
  it('주소가 없으면 읽지 않는다', async () => {
    await expect(readBundleOnLedger({}, RPC, 'daegu-eligibility', '2026.2')).rejects.toThrow('RuleRegistry');
  });
});

describe('F30 StatusListRegistry 읽기', () => {
  it('목록 전체를 받아 단말 안에서 비트를 본다', async () => {
    const list = createStatusList();
    setStatus(list, 77, true);
    const result = encodeFunctionResult({
      abi: GET_LIST_ABI,
      functionName: 'get',
      result: [stringToHex(encodeStatusList(list)), 3n, 1760000000n, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
    });
    const fetchMock = rpc({ result });
    vi.stubGlobal('fetch', fetchMock);
    const bits = await readStatusList(ADDR, RPC, 'dbp:status:welfare:list-1');
    expect(bits).not.toBeNull();
    expect(revokedIn(bits!, 77)).toBe(true);
    expect(revokedIn(bits!, 78)).toBe(false);
    // 원장 조회에는 목록 id 만 실린다 — 내 인덱스는 단말 밖으로 나가지 않는다
    const sent = String(fetchMock.mock.calls[0]![1].body);
    expect(sent).not.toContain('"77"');
  });
  it('미게시 목록(revert LIST_UNKNOWN)은 null', async () => {
    vi.stubGlobal('fetch', rpc({ revert: 'LIST_UNKNOWN' }));
    await expect(readStatusList(ADDR, RPC, 'dbp:status:nobody:list-1')).resolves.toBeNull();
  });
});

describe('ReceiptAnchor 읽기', () => {
  it('기록 시각(초)을 돌려준다', async () => {
    vi.stubGlobal('fetch', rpc({ result: '0x' + (1760000123).toString(16).padStart(64, '0') }));
    await expect(readAnchoredAt(ADDR, RPC, HASH)).resolves.toEqual({ anchoredAt: 1760000123 });
  });
  it('해시 형식이 틀리면 원장에 묻지 않는다', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(readAnchoredAt(ADDR, RPC, '0x1234')).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('API 호출 형태', () => {
  function okJson(body: unknown, headers: Record<string, string> = {}) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } }));
  }

  it('F34 결과 조회는 X-Vp-Hash 헤더로 (본문 없음, 다시 제출하지 않음)', async () => {
    const f = okJson({ requestId: 'r1', status: 'pending' });
    vi.stubGlobal('fetch', f);
    await expect(verifierApi.result('r1', '0xfeed')).resolves.toEqual({ requestId: 'r1', status: 'pending' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/results\/r1$/);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-vp-hash']).toBe('0xfeed');
    expect(init.body).toBeUndefined();
  });

  it('F20 상담 세션 삭제는 본문 없는 keepalive DELETE, 실패해도 예외를 던지지 않는다', async () => {
    const f = okJson({ sessionId: 's1', discarded: true });
    vi.stubGlobal('fetch', f);
    await aiApi.deleteSession('s1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/chat\/s1$/);
    expect(init.method).toBe('DELETE');
    expect(init.keepalive).toBe(true);
    expect(init.body).toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    await expect(aiApi.deleteSession('s1')).resolves.toBeUndefined();
  });

  it('F12 감사 기록은 내 auditId 로만 조회한다', async () => {
    const f = okJson({ available: true, kind: 'recommend', provider: 'template', model: null, payload: {} });
    vi.stubGlobal('fetch', f);
    await aiApi.audit('a/b');
    expect((f.mock.calls[0] as unknown as [string])[0]).toMatch(/\/audit\/a%2Fb$/);
  });

  it('F12·F21 스트리밍 채팅: X-Audit-Id 헤더와 masked 를 읽는다', async () => {
    const sse = 'data: {"delta":"안녕"}\n\ndata: {"delta":"하세요"}\n\ndata: {"done":true,"provider":"template","masked":true}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-audit-id': 'aud-1' } })),
    );
    const deltas: string[] = [];
    const r = await aiApi.chatStream(
      { sessionId: 's1', message: 'q', categoricalProfile: {} as never, ruleResults: [] },
      (d) => deltas.push(d),
    );
    expect(r).toMatchObject({ text: '안녕하세요', provider: 'template', auditId: 'aud-1', masked: true });
    expect(deltas).toEqual(['안녕', '하세요']);
  });

  it('헤더가 노출되지 않으면 done 이벤트의 auditId 를 쓴다', async () => {
    const sse = 'data: {"delta":"네"}\n\ndata: {"done":true,"provider":"template","auditId":"aud-2","masked":false}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const r = await aiApi.chatStream({ sessionId: 's1', message: 'q', categoricalProfile: {} as never, ruleResults: [] }, () => undefined);
    expect(r).toMatchObject({ auditId: 'aud-2', masked: false });
  });

  it('429 TOO_MANY_LOOKUPS 는 한국어 안내로', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'TOO_MANY_LOOKUPS' }), { status: 429 })));
    const err = await verifierApi.request('123456').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('TOO_MANY_LOOKUPS');
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).message).toContain('잠시 후 다시 시도하세요');
  });

  it('시간 초과는 TIMEOUT 코드 (제출 화면은 이때 다시 POST 하지 않고 결과를 조회한다)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('timed out', 'TimeoutError');
      }),
    );
    const err = await verifierApi.present({ requestId: 'r1', vpJwt: 'x' }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('TIMEOUT');
  });

  it('F18 AI 호출 시간 제한은 서버의 LLM 포기 시간(25초)보다 넉넉하다', () => {
    expect(AI_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    expect(PRESENT_TIMEOUT_MS).toBeGreaterThan(10_000);
  });
});
