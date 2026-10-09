"""LedgerClient 의 장애 구분·타임아웃·캐시·전송 직렬화 테스트 (원장 노드 없이 가짜 JSON-RPC 로 확인)."""
from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dbp_ledger.client as client_mod
import pytest
import rlp
from dbp_ledger import LedgerClient, LedgerUnavailable, load_deployment
from eth_abi import encode
from web3.exceptions import ContractLogicError

DEPLOYMENT = load_deployment()
HARDHAT_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # 공개 테스트 키


class FakeRpc:
    """mode: "ok" | "hang" | "revert" | "rpc-error". 요청 수와 메서드를 기록한다."""

    def __init__(self, mode: str = "ok", hang_s: float = 5.0):
        self.mode = mode
        self.hang_s = hang_s
        self.calls: list[str] = []
        self.nonce = 0
        self.lock = threading.Lock()
        rpc = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                rpc.calls.append(body["method"])
                if rpc.mode == "hang":
                    time.sleep(rpc.hang_s)
                out = {"jsonrpc": "2.0", "id": body["id"]}
                out.update(rpc.answer(body["method"], body.get("params", [])))
                data = json.dumps(out).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def answer(self, method: str, params: list) -> dict:
        if method == "eth_chainId":
            return {"result": hex(DEPLOYMENT.chain_id)}
        if method == "eth_call":
            if self.mode == "revert":
                data = "0x08c379a0" + encode(["string"], ["ISSUER_UNKNOWN"]).hex()
                return {"error": {"code": 3, "message": "execution reverted: ISSUER_UNKNOWN", "data": data}}
            if self.mode == "rpc-error":
                return {"error": {"code": -32603, "message": "internal error"}}
            return {"result": "0x" + encode(["bool"], [True]).hex()}
        if method == "eth_getTransactionCount":
            return {"result": hex(self.nonce)}
        if method == "eth_gasPrice":
            return {"result": "0x0"}
        if method == "eth_estimateGas":
            return {"result": hex(50_000)}
        return {"error": {"code": -32601, "message": f"unsupported {method}"}}

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def rpc():
    servers: list[FakeRpc] = []

    def make(mode: str = "ok", **kw) -> FakeRpc:
        s = FakeRpc(mode, **kw)
        servers.append(s)
        return s
    yield make
    for s in servers:
        s.close()


def _client(url: str, **kw) -> LedgerClient:
    return LedgerClient(rpc_url=url, deployment=DEPLOYMENT, **kw)


def _closed_port_url() -> str:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"


# ---------------------------------------------------------------- F34: 타임아웃·재시도 없음·장애 구분
def test_hung_ledger_raises_unavailable_within_timeout_without_retry(rpc):
    srv = rpc("hang", hang_s=3.0)
    lc = _client(srv.url, timeout_s=0.5)
    t0 = time.monotonic()
    with pytest.raises(LedgerUnavailable):
        lc.issuer_exists("did:dbp:daegu")
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0, f"멈춘 원장 조회가 {elapsed:.1f}s 걸림 — 재시도가 남아 있다"
    assert len(srv.calls) == 1  # 첫 요청에서 바로 실패, 재시도 0회


def test_default_read_timeout_is_about_three_seconds():
    lc = LedgerClient(rpc_url=_closed_port_url(), deployment=DEPLOYMENT)
    assert lc.timeout_s <= 3.0
    assert lc.w3.provider.exception_retry_configuration is None


def test_connection_refused_raises_unavailable():
    lc = _client(_closed_port_url())
    for call in (lambda: lc.get_issuer("did:dbp:daegu"), lambda: lc.get_status_list("dbp:status:daegu:list-1"),
                 lambda: lc.get_bundle("daegu-eligibility", "2026.2"), lc.block_number):
        with pytest.raises(LedgerUnavailable):
            call()


def test_ledger_unavailable_is_exported_and_distinct_from_revert(rpc):
    srv = rpc("revert")
    lc = _client(srv.url)
    with pytest.raises(ContractLogicError) as ei:
        lc.get_issuer("did:dbp:nobody")
    assert not isinstance(ei.value, LedgerUnavailable)  # 미등록 = "없음", 장애 아님


def test_non_revert_rpc_error_is_unavailable(rpc):
    srv = rpc("rpc-error")
    with pytest.raises(LedgerUnavailable):
        _client(srv.url).issuer_exists("did:dbp:daegu")


# ---------------------------------------------------------------- F59: 캐시 상한
class _Counter:
    def __init__(self, result):
        self.n = 0
        self.result = result

    def __call__(self, *_a):
        counter = self

        class _Call:
            def call(self_inner):
                counter.n += 1
                return counter.result
        return _Call()


class _Fns:
    def __init__(self, **fns):
        self.__dict__.update(fns)


class _Contract:
    def __init__(self, **fns):
        self.functions = _Fns(**fns)


ISSUER_ROW = ("did:dbp:daegu", b"\x01" * 32, "대구광역시", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", True, 1)
LIST_ROW = (b"H4sIAAAA", 3, 100, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8")


def _fake_clock(monkeypatch, start: float = 1000.0):
    now = [start]
    monkeypatch.setattr(client_mod.time, "monotonic", lambda: now[0])
    return now


def test_issuer_cache_ttl_at_most_five_seconds(monkeypatch):
    lc = _client(_closed_port_url(), issuer_cache_ttl_s=60)  # 큰 값을 줘도 5초로 제한
    assert lc.issuer_cache_ttl_s <= 5.0
    get = _Counter(ISSUER_ROW)
    lc._c["IssuerRegistry"] = _Contract(get=get)
    now = _fake_clock(monkeypatch)
    issuer = lc.get_issuer("did:dbp:daegu")
    assert issuer["controller"] == ISSUER_ROW[3] and issuer["active"] is True
    now[0] += 4.9
    lc.get_issuer("did:dbp:daegu")
    assert get.n == 1
    now[0] += 0.2  # 5.1초 경과 → 원장에서 다시 읽는다(정지·키 교체 반영)
    lc.get_issuer("did:dbp:daegu")
    assert get.n == 2


def test_status_list_not_cached_by_default_and_never_beyond_two_seconds(monkeypatch):
    lc = _client(_closed_port_url())
    get = _Counter(LIST_ROW)
    lc._c["StatusListRegistry"] = _Contract(get=get)
    sl = lc.get_status_list("dbp:status:daegu:list-1")
    assert sl["owner"] == LIST_ROW[3] and sl["version"] == 3
    lc.get_status_list("dbp:status:daegu:list-1")
    assert get.n == 2  # 기본: 매번 원장에서 읽는다

    lc2 = _client(_closed_port_url(), status_list_cache_ttl_s=30)
    assert lc2.status_list_cache_ttl_s <= 2.0
    get2 = _Counter(LIST_ROW)
    lc2._c["StatusListRegistry"] = _Contract(get=get2)
    now = _fake_clock(monkeypatch)
    lc2.get_status_list("x")
    now[0] += 2.1
    lc2.get_status_list("x")
    assert get2.n == 2


def test_failed_reads_are_not_cached(monkeypatch):
    lc = _client(_closed_port_url())
    calls = {"n": 0}

    class _Boom:
        def call(self):
            calls["n"] += 1
            raise ContractLogicError("execution reverted: ISSUER_UNKNOWN")
    lc._c["IssuerRegistry"] = _Contract(get=lambda _did: _Boom())
    for _ in range(2):
        with pytest.raises(ContractLogicError):
            lc.get_issuer("did:dbp:late")
    assert calls["n"] == 2  # 미등록 결과를 붙잡아 두지 않는다


# ---------------------------------------------------------------- F61: nonce 할당 → 전송 직렬화
def test_concurrent_sends_get_distinct_nonces(rpc, monkeypatch):
    srv = rpc("ok")
    lc = _client(srv.url, private_key=HARDHAT_KEY_1)
    sent_nonces: list[int] = []
    inflight = {"now": 0, "max": 0}
    guard = threading.Lock()

    real_count = lc.w3.eth.get_transaction_count

    def count(addr, block):
        with guard:
            inflight["now"] += 1
            inflight["max"] = max(inflight["max"], inflight["now"])
        time.sleep(0.05)  # 경합 창을 넓힌다
        return real_count(addr, block)

    def send_raw(raw):
        nonce = int.from_bytes(rlp.decode(bytes(raw))[0] or b"\x00", "big")  # 레거시 tx: [nonce, gasPrice, …]
        sent_nonces.append(nonce)
        srv.nonce = nonce + 1  # 노드의 pending nonce 가 전송 즉시 올라간다
        with guard:
            inflight["now"] -= 1
        return bytes([nonce]) * 32

    monkeypatch.setattr(lc.w3.eth, "get_transaction_count", count)
    monkeypatch.setattr(lc.w3.eth, "send_raw_transaction", send_raw)
    monkeypatch.setattr(lc.w3.eth, "wait_for_transaction_receipt", lambda h, timeout=60: {"status": 1})

    errors: list[BaseException] = []

    def worker(i: int):
        try:
            lc.anchor_receipt("0x" + f"{i:02x}" * 32, 1)
        except Exception as e:  # noqa: BLE001 — 실패 시 보고
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert inflight["max"] == 1  # 한 번에 하나만 nonce 를 받는다
    assert sorted(sent_nonces) == list(range(6))


def test_send_lock_is_shared_per_account_across_clients(rpc):
    srv = rpc("ok")
    a = _client(srv.url, private_key=HARDHAT_KEY_1)
    b = _client(srv.url, private_key=HARDHAT_KEY_1)
    assert client_mod._send_lock(a.rpc_url, a.account.address) is client_mod._send_lock(b.rpc_url, b.account.address)
