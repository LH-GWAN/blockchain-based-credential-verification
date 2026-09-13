SHELL := /bin/bash
.DEFAULT_GOAL := help

help: ## 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

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

demo: ## 체인 + 서비스 + 앱 전체 기동 (docs/DEMO.md 참고)
	./scripts/demo.sh

compose-up: ## docker compose 로 전체 스택 기동 (네트워크 격리 포함)
	docker compose up --build -d

compose-down: ## compose 스택 종료
	docker compose down -v

demo-isolation: ## 검증기관 컨테이너에서 발급기관 접속이 차단됨을 확인 (compose 기동 상태에서)
	@echo "verifier → issuer-daegu:8001 (차단되어야 함)"; \
	docker compose exec -T verifier python -c "import urllib.request,sys; \
	  urllib.request.urlopen('http://issuer-daegu:8001/health', timeout=3)" 2>&1 | tail -1 || echo "✅ 차단됨: 검증기관은 발급기관에 닿을 수 없습니다"
	@echo "verifier → chain:8545 (허용되어야 함)"; \
	docker compose exec -T verifier python -c "import urllib.request; \
	  print('✅ 원장 접근 가능:', urllib.request.urlopen(urllib.request.Request('http://chain:8545', data=b'{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}', headers={'content-type':'application/json'}), timeout=3).read().decode())"

bench: ## 검증 성능 벤치 (make demo 기동 상태에서) → docs/bench.json
	uv run python scripts/bench_verify.py 50

e2e: ## Playwright 로 시연 ①~⑤ 자동 재현 + docs/screenshots 갱신 (make demo 기동 상태에서; WALLET_URL/VERIFIER_APP_URL 로 포트 지정)
	pnpm --filter @dbp/e2e test

smoke: ## 체인 기동부터 발급·검증·폐기·공격·벤치·PII 스캔까지 헤드리스 통합 확인
	./scripts/smoke_e2e.sh 50

.PHONY: help setup build test chain deploy seed expected report demo compose-up compose-down demo-isolation bench e2e smoke
