"""테스트 공용 도우미 (고유한 모듈명 — 저장소 전체 실행 시 다른 패키지의 conftest 와 충돌하지 않도록)."""
from __future__ import annotations

import json
from contextlib import contextmanager
from types import SimpleNamespace

INELIGIBLE_FOR_PERSONA = {"nbl-livelihood", "nbl-education", "energy-voucher"}
PROBE_MESSAGE = "대구 청년 행복수당 받을 수 있나요?"
VERDICT_MARKERS = [
    "받을 수 있습니다", "받으실 수 있습니다", "신청하실 수 있습니다", "신청할 수 있습니다", "기준을 충족",
    "해당하지 않습니다", "해당합니다", "적격", "부적격", "대상입니다", "대상이 아닙니다",
]


# ---- 가짜 Anthropic 클라이언트 ----


def fake_usage():
    return SimpleNamespace(input_tokens=1200, output_tokens=300, cache_read_input_tokens=1000, cache_creation_input_tokens=0)


class FakeAnthropic:
    """client.messages.parse / create / stream 만 흉내 낸다. 호출 kwargs 를 `calls` 에 기록한다."""

    def __init__(self, *, parsed_output=None, stop_reason="end_turn", text="", deltas=None, error=None,
                 stream_error_after=None):
        self.parsed_output = parsed_output
        self.stop_reason = stop_reason
        self.text = text
        self.deltas = deltas or []
        self.error = error
        self.stream_error_after = stream_error_after
        self.calls: list[tuple[str, dict]] = []
        self.messages = self  # client.messages.<method>

    def parse(self, **kwargs):
        self.calls.append(("parse", kwargs))
        if self.error:
            raise self.error
        return SimpleNamespace(parsed_output=self.parsed_output, stop_reason=self.stop_reason,
                               usage=fake_usage(), model=kwargs["model"], content=[])

    def create(self, **kwargs):
        self.calls.append(("create", kwargs))
        if self.error:
            raise self.error
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.text)], stop_reason=self.stop_reason,
                               usage=fake_usage(), model=kwargs["model"])

    @contextmanager
    def stream(self, **kwargs):
        self.calls.append(("stream", kwargs))
        if self.error:
            raise self.error
        fake = self

        class _Stream:
            def __iter__(self):
                for i, d in enumerate(fake.deltas):
                    if fake.stream_error_after is not None and i >= fake.stream_error_after:
                        raise RuntimeError("stream broke")
                    yield SimpleNamespace(type="text", text=d)

            def get_final_message(self):
                return SimpleNamespace(stop_reason=fake.stop_reason, usage=fake_usage(),
                                       content=[SimpleNamespace(type="text", text="".join(fake.deltas))])

        yield _Stream()


def parse_sse(body: str) -> list[dict]:
    events = []
    for line in body.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: "):]))
    return events
