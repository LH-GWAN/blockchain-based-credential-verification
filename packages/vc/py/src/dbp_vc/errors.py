"""라이브러리 전역 오류. `code`는 §9 거부 사유 코드와 맞춘다
(AUD_MISMATCH, VP_SIG_INVALID, VC_SIG_INVALID, ...). 그 외 입력 오류는 MALFORMED / FLOAT_FORBIDDEN 등."""


class VcError(Exception):
    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code
