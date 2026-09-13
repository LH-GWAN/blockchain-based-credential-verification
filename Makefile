SHELL := /bin/bash
.DEFAULT_GOAL := help

help: ## 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## 의존성 설치 (pnpm + uv)
	pnpm install
	uv sync --all-packages

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

.PHONY: help setup build test chain deploy seed expected report demo
