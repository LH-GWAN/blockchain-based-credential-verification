"""시각 변환. 타임존이 명시된 ISO 8601만 허용 (naive 문자열은 JS/Python 해석이 달라지므로 거부)."""

import math
import re
from datetime import UTC, datetime

from .errors import VcError

_ISO_WITH_TZ = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def iso_to_seconds(iso: str) -> int:
    """ISO 8601(타임존 필수) → epoch seconds (정수, 내림)."""
    if not isinstance(iso, str) or not _ISO_WITH_TZ.match(iso):
        raise VcError("MALFORMED", f"ISO 8601 timestamp with timezone required: {iso!r}")
    try:
        dt = datetime.fromisoformat(iso)  # 3.11+: "Z" 직접 지원
    except ValueError as e:
        raise VcError("MALFORMED", f"invalid timestamp: {iso}") from e
    return math.floor(dt.timestamp())


def to_seconds(now: datetime | int | None) -> int:
    """datetime(naive면 UTC로 간주) | epoch int | None(현재) → epoch seconds."""
    if now is None:
        return math.floor(datetime.now(tz=UTC).timestamp())
    if isinstance(now, int):
        return now
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    return math.floor(now.timestamp())
