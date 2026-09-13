# services/ai — 대구 혜택패스 AI 서비스 (`dbp_ai`)

FastAPI 앱. **AI는 탐색·설명만 한다.** 적격 판정은 규칙 엔진(`dbp_rules`)이 이미 끝냈고, 이 서비스는 그 결과를
쉬운 한국어로 설명·정렬·안내한다 (§2 불변 조건 1·6·7, §10).

## 실행

```bash
uv sync --all-packages                    # 저장소 루트
LLM_PROVIDER=template uv run python -m dbp_ai     # 오프라인 시연 (LLM 없이 템플릿)
ANTHROPIC_API_KEY=sk-ant-... uv run python -m dbp_ai   # Claude 사용
curl -s localhost:8004/health             # {"ok":true,"provider":"template","model":"claude-opus-5"}
uv run pytest services/ai                 # 네트워크 없이 전부 실행
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `AI_PORT` / `AI_HOST` | `8004` / `0.0.0.0` | 서버 바인딩 |
| `LLM_PROVIDER` | `anthropic` | `anthropic` \| `template`. 키가 없으면 자동으로 `template` |
| `LLM_MODEL` | `claude-opus-5` | Anthropic 모델 ID |
| `ANTHROPIC_API_KEY` | (없음) | 비우면 템플릿 provider |
| `LLM_TIMEOUT_S` | `60` | SDK 타임아웃(초). 초과 시 템플릿 폴백 |
| `DBP_REPO_ROOT` | 자동 탐지 | `data/policies/*.json` 위치 (컨테이너에서 지정) |

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/health` | `{ ok, provider, model }` — provider 는 실제로 쓰일 값 |
| `POST` | `/recommend` | `{ categoricalProfile, ruleResults[], locale:"ko" }` → `{ recommendations[≤3], disclaimer, provider, judgedBy:"rule-engine" }`. 항목: `{ policyId, headline, explanation, citations[clauseId], nextSteps, source:"llm"\|"template" }` |
| `POST` | `/chat` | SSE. `data: {"delta":"..."}` 반복 후 `data: {"done":true,"provider":...,"sessionId":...}` |
| `POST` | `/chat/complete` | 비스트리밍 `{ sessionId, text, provider, judgedBy }` (테스트·폴백용) |
| `DELETE` | `/chat/{sessionId}` | 메모리 세션 폐기 |
| `GET` | `/audit/last-payload` | 마지막 LLM 호출에 **실제로 전달된** `model`·`system`·`messages` (템플릿이면 그 입력). 지갑 "AI가 받은 정보 보기" |

`categoricalProfile` 허용 필드는 정확히 `ageBand, householdSize, residence, incomeBracket, recipientStatus, creditTier`
뿐이다 (`extra="forbid"`). 그 외 필드(예: `monthlyIncomeKRW`, `name`)는 422 — 이것이 PII 방화벽이다.

## 가드레일 (전부 `tests/` 로 강제)

1. **후보 = 규칙 엔진 적격만** — `ruleResults.eligible == true` 인 정책만 후보. 부적격은 "추천 금지" 목록으로만 LLM 에 보인다 (질문 대응용).
2. **구조화 출력** — `client.messages.parse(..., output_format=RecommendationResponse)`. `stop_reason == "refusal"` 또는 SDK 오류 → 템플릿 폴백. 절대 크래시하지 않는다.
3. **인용 검증기** (`validator.py`) — 후보 밖 policyId, 빈 citations, 정책 `legalBasis` 에 없는 clauseId, 정책 DB 에 근거 없는 제도명 언급 → 항목 제거. 3개 미만이면 남은 적격 정책을 템플릿(`source:"template"`)으로 채운다.
4. **템플릿 provider** (`template.py`) — `summary + howToApply + legalBasis[0]` 로 결정론적 설명, `legalBasis[0].clauseId` 인용. 정렬 복지 → 금융 → 교통 → 기타 → policyId.
5. **시스템 프롬프트** (`prompts.py`) — 자격 판정 금지, 규칙 엔진 결과만 설명, 미등록 제도는 "등록되어 있지 않습니다", 원본 개인정보 요구·추정 금지, 쉬운 한국어·존댓말·짧은 문장. 정책 문서 전체(name·summary·howToApply·legalBasis clauseId/title/text·notes)를 in-context 코퍼스로 포함. 채팅은 범주 프로필·판정 결과를 두 번째 system 블록으로 추가.
6. **환각 프로브** — "대구 청년 행복수당 받을 수 있나요?" → "등록되어 있지 않" 포함, 자격 판정 문구 없음.
7. **PII 차단 후킹** — 단일 경계 `llm.llm_call(kind, payload)` 가 SDK 호출 직전에 `LAST_PAYLOAD` 를 기록한다. 테스트는 이 함수를 가짜로 바꿔 페이로드에 `monthlyIncomeKRW`·`birthDate`·`name`·주민번호 패턴·7자리 이상 숫자가 없음을 assert.
8. **로그** — provider·model·kind·latency_ms·토큰 수만. 프롬프트/응답 본문은 남기지 않는다.

## SDK 호출 형태

```python
client.messages.parse(
    model=LLM_MODEL, max_tokens=4096,
    system=[{"type": "text", "text": SYSTEM_PROMPT_WITH_POLICY_DOCS, "cache_control": {"type": "ephemeral"}}],
    messages=[{"role": "user", "content": "<범주 프로필 + 적격/부적격 목록 + 요청>"}],
    output_format=RecommendationResponse, thinking={"type": "adaptive"}, output_config={"effort": "medium"},
)  # → response.parsed_output
```

채팅은 같은 system 프리픽스 + `{"type":"text","text": <범주 프로필·판정 결과>}` 블록을 붙여 `client.messages.create(...)`
(`/chat/complete`) 또는 `client.messages.stream(...)` (`/chat`, `event.type == "text"` 델타) 로 부른다.
고정 프리픽스(규칙 + 정책 문서)에만 `cache_control` 을 걸고 가변 값은 그 뒤에 둔다.

## 모듈

| 파일 | 역할 |
|---|---|
| `schemas.py` | Pydantic 계약 (모두 `extra="forbid"`) |
| `retriever.py` | `PolicyStore`(정책 DB 인덱스, 제도명 allowlist) · `Retriever` 프로토콜 · `InContextRetriever` |
| `prompts.py` | 시스템 프롬프트(규칙 + 정책 코퍼스), 사용자 메시지·채팅 컨텍스트 빌더 |
| `llm.py` | `llm_call(kind, payload)` 단일 경계, `LAST_PAYLOAD`, 클라이언트 주입(`set_client`) |
| `validator.py` | 인용 검증기 |
| `template.py` | 템플릿 추천·상담 |
| `recommend.py` / `chat.py` | 오케스트레이션 (LLM → 검증 → 템플릿 보충 / 세션·SSE) |
| `app.py` / `__main__.py` | FastAPI 라우트 / uvicorn 진입점 |

**RAG 확장 경로**: 정책이 10개 이하라 벡터 DB 없이 전체 문서를 컨텍스트에 넣는다. 정책이 늘면 `Retriever` 프로토콜을
구현한 검색기(임베딩·BM25 등)로 `InContextRetriever` 를 교체하고 `build_system_prompt(store, retriever)` 에 넘기면 된다.
검증기는 검색 결과가 아니라 정책 DB 전체를 기준으로 인용을 확인하므로 그대로 쓴다.

## 구현 메모

- 정책 문서의 `sourceUrl` 은 프롬프트에 넣지 않는다 (모델에 불필요하고, 게시글 번호 등 7자리 이상 숫자가 있어 "원본 금액 0건" 검사와 충돌).
- `telecom-discount` 는 분류가 `생활` 이라 복지·금융·교통 뒤에 정렬된다.
- 응답의 `provider` 는 이번 요청에서 LLM 호출이 성공했는지를 뜻한다. LLM 항목이 검증기에서 전부 걸러져도 `provider:"anthropic"` 이며, 항목별 `source` 로 출처를 구분한다.
- 세션은 프로세스 메모리 dict 에만 있다 (최대 20 메시지). 재시작하면 사라진다.
