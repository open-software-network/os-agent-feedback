.PHONY: help install node-install backend-install node-version-check dev-env dev-setup dev-bootstrap dev-compose-check dev-db dev-db-stop dev-backend dev-web backend-fmt-check backend-clippy backend-test backend-openapi backend-openapi-check biome-check biome-fix node-test sdk-node-test web-install web-types-check web-check web-typecheck web-test web-release-e2e web-build docs-validate docs-a11y types check

.DEFAULT_GOAL := help

help:  ## Show this help (targets with a `##` comment)
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# --- Setup ---
install: node-install backend-install  ## Install locked Node dependencies and Rust lint/format components

node-install:  ## Install all pnpm workspace dependencies from the lockfile
	pnpm install --frozen-lockfile

backend-install:  ## Install the Rust components required by backend checks
	@command -v rustup >/dev/null 2>&1 || { echo "rustup is required; install it from https://rustup.rs and retry." >&2; exit 1; }
	rustup component add clippy rustfmt

node-version-check:  ## Require the repository's supported Node range (>=22.13.0 <25)
	@command -v node >/dev/null 2>&1 || { echo "Node.js is required; install Node >=22.13.0 <25 and retry." >&2; exit 1; }
	@node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || major >= 25 || (major === 22 && minor < 13)) { console.error(`Node $${process.versions.node} is unsupported; switch to Node >=22.13.0 <25 and retry.`); process.exit(1); }'

# --- Local development ---
DEV_BACKEND_ENV_FILE ?= backend/.env
DEV_WEB_ENV_FILE ?= web/.env.local

dev-env:  ## Create missing local env files without changing existing files
	@if test -f "$(DEV_BACKEND_ENV_FILE)"; then echo "Preserved $(DEV_BACKEND_ENV_FILE)"; else cp backend/.env.example "$(DEV_BACKEND_ENV_FILE)"; echo "Created $(DEV_BACKEND_ENV_FILE)"; fi
	@if test -f "$(DEV_WEB_ENV_FILE)"; then echo "Preserved $(DEV_WEB_ENV_FILE)"; else cp web/.env.example "$(DEV_WEB_ENV_FILE)"; echo "Created $(DEV_WEB_ENV_FILE)"; fi

dev-setup: node-version-check node-install backend-install dev-env  ## Install dependencies and create missing local env files
	@echo "Local setup complete. Existing environment files were left unchanged."

dev-bootstrap:  ## Prepare local development and start healthy PostgreSQL
	@$(MAKE) --no-print-directory dev-setup
	@$(MAKE) --no-print-directory dev-db
	@printf '%s\n' "Bootstrap complete. PostgreSQL is healthy." "" "Next:" "  Terminal 1: make dev-backend" "  Terminal 2: make dev-web"

dev-compose-check:
	@command -v docker-compose >/dev/null 2>&1 || { echo "docker-compose is required; install a Compose-compatible runtime and retry." >&2; exit 1; }
	@docker-compose up --help 2>&1 | grep -q -- '--wait' || { echo "docker-compose must support 'up --wait' so PostgreSQL health can be verified." >&2; exit 1; }

dev-db: dev-compose-check  ## Start the local PostgreSQL container and wait until it is healthy
	docker-compose -f backend/docker-compose.yml up -d --wait postgres

dev-db-stop: dev-compose-check  ## Stop local PostgreSQL without deleting its data
	docker-compose -f backend/docker-compose.yml stop postgres

dev-backend: dev-db  ## Start the Rust API on http://localhost:8080
	cd backend && cargo run --locked --bin agent-feedback

dev-web: node-version-check  ## Start the Next.js dashboard on http://localhost:3000
	pnpm --filter @epode/web dev

# --- Backend ---
backend-fmt-check:  ## Check backend Rust formatting
	cd backend && cargo fmt --check

backend-clippy:  ## Run strict Clippy checks for every backend target
	cd backend && cargo clippy --all-targets --locked -- -D warnings

backend-test:  ## Run the locked backend Rust test suite
	cd backend && cargo test --locked

backend-openapi:  ## Regenerate the committed backend OpenAPI document
	@set -e; \
		tmp_file=$$(mktemp -t epode-openapi); \
		trap 'rm -f "$$tmp_file"' EXIT; \
		(cd backend && cargo run --quiet --bin agent-feedback -- --print-openapi) > "$$tmp_file"; \
		install -m 644 "$$tmp_file" backend/openapi.json

backend-openapi-check:  ## Check the committed backend OpenAPI document for drift
	@set -e; \
		generated_spec=$$(cd backend && cargo run --quiet --bin agent-feedback -- --print-openapi); \
		printf '%s\n' "$$generated_spec" | diff -u backend/openapi.json -

# --- Node ---
biome-check:  ## Check formatting and linting for Biome-managed files
	pnpm check

biome-fix:  ## Apply safe formatting and lint fixes to Biome-managed files
	pnpm check:fix

node-test:  ## Run the root Node test suite
	pnpm test

sdk-node-test:  ## Build and test the Node SDK
	cd sdk/node && pnpm test

# --- Web ---
web-install: node-version-check  ## Install the web workspace dependencies from the lockfile
	pnpm --filter @epode/web install --frozen-lockfile

web-types-check: node-version-check  ## Check committed web API types for drift
	@pnpm run gen:types
	@git diff --exit-code -- web/lib/api/types.ts || { \
		echo "Generated web API types are stale. Run 'pnpm run gen:types' and commit web/lib/api/types.ts." >&2; \
		exit 1; \
	}

web-check: node-version-check  ## Check web formatting and linting
	pnpm --filter @epode/web check

web-typecheck: node-version-check  ## Typecheck the web workspace
	pnpm --filter @epode/web typecheck

web-test: node-version-check  ## Run the web unit and component tests
	pnpm --filter @epode/web test

web-release-e2e: node-version-check  ## Run the disposable signed-in dashboard browser release check
	pnpm --filter @epode/web run test:release-e2e

web-build: node-version-check  ## Build the standalone Next.js web artifact
	pnpm --filter @epode/web build

# --- Docs ---
docs-validate: node-version-check  ## Validate the Mintlify documentation
	pnpm run docs:validate

docs-a11y: node-version-check  ## Run Mintlify accessibility checks
	pnpm run docs:a11y

# --- Generated API types ---
types: node-version-check backend-openapi  ## Regenerate OpenAPI TypeScript types for the phase 2 web app
	pnpm run gen:types

# --- Combined ---
# node-version-check runs first on purpose: the docs targets at the end hard-fail
# on Node 25+, and without the early gate that failure arrives only after a full
# cargo build and the whole Node suite.
# Do not run this with `make -j`: the backend targets serialize on cargo's build
# directory lock anyway, and concurrent pnpm targets can race on node_modules if
# the tree is stale.
# The production web build stays separate: it is an artifact-producing, slower
# gate, while formatting, types, and tests provide the cheap feedback loop here.
check: node-version-check backend-fmt-check backend-clippy backend-test backend-openapi-check biome-check node-test sdk-node-test web-check web-typecheck web-test docs-validate docs-a11y  ## Run all backend, OpenAPI, Node, SDK, web, and docs checks
