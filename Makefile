SHELL := /bin/bash
.DEFAULT_GOAL := help

help: ## 명령 목록
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## 의존성 설치 (pnpm + uv)
	pnpm install
	uv sync --all-packages
	./scripts/fix_venv.sh

build: ## TS 패키지 빌드 + 컨트랙트 컴파일
	pnpm -r --filter './packages/**' build
	pnpm --filter @dbp/chain compile

test: ## 전체 테스트 (Python + TS + 컨트랙트)
	uv run pytest -q
	pnpm -r --filter './packages/**' test
	pnpm --filter @dbp/chain test

chain: ## 로컬 체인(Hardhat) 기동 (포그라운드)
	pnpm --filter @dbp/chain node

deploy: ## 로컬 체인에 컨트랙트 배포
	pnpm --filter @dbp/chain deploy:localhost

seed: ## 발급기관·규칙 번들·상태목록을 원장에 등록
	uv run python scripts/seed_ledger.py

expected: ## 합성 시민·기댓값 재생성
	uv run python scripts/gen_citizens.py
	uv run python -m dbp_rules.gen_expected

report: ## 테스트 리포트 생성 → docs/TEST_REPORT.md
	uv run python scripts/make_report.py

demo: ## 체인 + 서비스 + 앱 전체 기동 (docs/DEMO.md 참고) — 기본 시연 경로
	./scripts/demo.sh

demo-issuers: ## ⑦(발급기관 정지) 뒤 발급기관 2곳만 다시 기동 (make demo 와 같은 포트·.demo/issuer-*.db)
	./scripts/demo.sh issuers

# compose 스택은 격리 시연 전용이다: chain·issuer·verifier 는 internal 네트워크에만 붙어 있어 호스트 포트가 열리지 않는다
# (지갑·검증기관 앱 컨테이너가 떠도 브라우저가 서비스에 닿지 못한다). 지갑으로 하는 시연은 make demo 를 쓴다.
compose-up: ## [격리 시연 전용] docker compose 로 전체 스택 기동 — 서비스 호스트 포트가 열리지 않으므로 지갑 시연은 make demo
	docker compose up --build -d

compose-isolation-up: ## 격리 시연용 최소 스택(체인·발급기관·검증기관)을 호스트 포트 없이 기동 — make demo 와 동시 사용 가능
	docker compose -f docker-compose.yml -f docker-compose.isolation.yml up -d chain deployer issuer-daegu issuer-welfare verifier

capture-isolation: ## make demo-isolation 출력을 docs/screenshots/17-isolation-terminal.{txt,png} 로 저장
	./scripts/capture_isolation.sh

compose-down: ## compose 스택 종료
	docker compose down -v

demo-isolation: ## compose 인스턴스에서 대조군(발급기관 응답) 확인 후, 검증기관 컨테이너 → 발급기관 차단·원장만 허용 확인 (⑦ 정지 전에)
	@docker compose exec -T issuer-welfare python - control < scripts/isolation_probe.py
	@docker compose exec -T verifier python - < scripts/isolation_probe.py

bench: ## 검증 서버 처리(/present 왕복) 성능 벤치 (make demo 기동 상태, 로컬·캐시 적중) → docs/bench.json
	uv run python scripts/bench_verify.py 50

e2e: ## Playwright 로 시연 ①~⑥(③′ 포함)+공격 4종 재현. ⑦은 E2E_ISSUER_DOWN_CMD 를 줄 때만(없으면 skipped) — 지갑 주소는 .demo/wallet.url 또는 WALLET_URL
	pnpm --filter @dbp/e2e test

smoke: ## 체인 기동부터 발급·검증·폐기·공격·벤치·PII 스캔까지 헤드리스 통합 확인 (서비스 포트 8101~8103, make demo 와 동시 실행 불가)
	./scripts/smoke_e2e.sh 50

.PHONY: help setup build test chain deploy seed expected report demo demo-issuers compose-up compose-isolation-up capture-isolation compose-down demo-isolation bench e2e smoke
