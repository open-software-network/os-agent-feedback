.PHONY: help install node-install backend-install node-version-check dev-env dev-setup dev-bootstrap dev-compose-check dev-db dev-db-stop dev-observability dev-observability-stop dev-backend dev-web tunnel-setup tunnel-run tunnel-route tunnel-routes tunnel-status backend-fmt-check backend-clippy backend-test backend-openapi backend-openapi-check biome-check biome-fix node-test sdk-node-test sdk-rust-test linked-journey-conformance web-install web-types-check web-check web-typecheck web-test web-release-e2e web-build docs-validate docs-a11y types check

.DEFAULT_GOAL := help

PYTHON ?= python3

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
DEV_CONTAINER_RUNTIME ?= docker

ifeq ($(DEV_CONTAINER_RUNTIME),podman)
DEV_COMPOSE = DOCKER_HOST="unix://$$(podman info --format '{{.Host.RemoteSocket.Path}}')" docker-compose
else
DEV_COMPOSE = docker-compose
endif

dev-env:  ## Create missing local env files without changing existing files
	@if test -f "$(DEV_BACKEND_ENV_FILE)"; then echo "Preserved $(DEV_BACKEND_ENV_FILE)"; else cp backend/.env.example "$(DEV_BACKEND_ENV_FILE)"; echo "Created $(DEV_BACKEND_ENV_FILE)"; fi
	@if test -f "$(DEV_WEB_ENV_FILE)"; then echo "Preserved $(DEV_WEB_ENV_FILE)"; else cp web/.env.example "$(DEV_WEB_ENV_FILE)"; echo "Created $(DEV_WEB_ENV_FILE)"; fi

dev-setup: node-version-check node-install backend-install dev-env  ## Install dependencies and create missing local env files
	@echo "Local setup complete. Existing environment files were left unchanged."

dev-bootstrap:  ## Prepare local development and start healthy PostgreSQL
	@$(MAKE) --no-print-directory dev-setup
	@$(MAKE) --no-print-directory dev-db
	@if test "$(DEV_CONTAINER_RUNTIME)" = podman; then backend_command="make dev-backend DEV_CONTAINER_RUNTIME=podman"; else backend_command="make dev-backend"; fi; \
		printf '%s\n' "Bootstrap complete. PostgreSQL is healthy." "" "Next:" "  Terminal 1: $$backend_command" "  Terminal 2: make dev-web"

dev-compose-check:
	@command -v docker-compose >/dev/null 2>&1 || { echo "docker-compose is required; install a Compose-compatible runtime and retry." >&2; exit 1; }
	@case "$(DEV_CONTAINER_RUNTIME)" in \
		docker) ;; \
		podman) command -v podman >/dev/null 2>&1 || { echo "DEV_CONTAINER_RUNTIME=podman requires podman." >&2; exit 1; }; \
			podman_socket="$$(podman info --format '{{.Host.RemoteSocket.Path}}')"; \
			test -S "$$podman_socket" || { echo "Podman did not report a live rootless socket." >&2; exit 1; } ;; \
		*) echo "DEV_CONTAINER_RUNTIME must be either docker or podman." >&2; exit 1 ;; \
	esac
	@$(DEV_COMPOSE) up --help 2>&1 | grep -q -- '--wait' || { echo "docker-compose must support 'up --wait' so PostgreSQL health can be verified." >&2; exit 1; }

dev-db: dev-compose-check  ## Start the local PostgreSQL container and wait until it is healthy
	$(DEV_COMPOSE) -f backend/docker-compose.yml up -d --wait postgres

dev-db-stop: dev-compose-check  ## Stop local PostgreSQL without deleting its data
	$(DEV_COMPOSE) -f backend/docker-compose.yml stop postgres

dev-observability: dev-compose-check  ## Start the local Grafana OTel stack (Grafana on http://localhost:3001)
	$(DEV_COMPOSE) -f backend/docker-compose.yml up -d --wait observability
	@echo "Grafana is on http://localhost:3001 (admin/admin). Set OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 in backend/.env and web/.env.local to export telemetry."

dev-observability-stop: dev-compose-check  ## Stop the local observability stack without deleting its data
	$(DEV_COMPOSE) -f backend/docker-compose.yml stop observability

dev-backend: dev-db  ## Start the Rust API on http://localhost:8080
	cd backend && cargo run --locked --bin agent-feedback

dev-web: node-version-check  ## Start the Next.js dashboard on http://localhost:3000
	pnpm --filter @epode/web dev

# --- Tunnel lab (public URLs for ChatGPT/Claude testing) ---
TUNNEL_DOMAIN ?=
TUNNEL_NAME ?=
TUNNEL_PORT ?=

tunnel-setup:  ## One-time: create the Cloudflare tunnel and wildcard DNS (requires TUNNEL_DOMAIN=lab.example.com)
	@test -n "$(TUNNEL_DOMAIN)" || { echo "Usage: make tunnel-setup TUNNEL_DOMAIN=lab.example.com" >&2; exit 1; }
	tunnel/tunnel.sh setup "$(TUNNEL_DOMAIN)"

tunnel-run:  ## Start the tunnel router and cloudflared in the foreground (Ctrl-C stops both)
	tunnel/tunnel.sh run

tunnel-route:  ## Publish NAME=<name> on local PORT=<port> as https://<name>.<tunnel-domain>
	@test -n "$(TUNNEL_NAME)" && test -n "$(TUNNEL_PORT)" || { echo "Usage: make tunnel-route TUNNEL_NAME=demo TUNNEL_PORT=4311" >&2; exit 1; }
	tunnel/tunnel.sh route add "$(TUNNEL_NAME)" "$(TUNNEL_PORT)"

tunnel-routes:  ## List published tunnel routes and their public URLs
	tunnel/tunnel.sh route ls

tunnel-status:  ## Show tunnel lab status (login, tunnel, router, routes)
	tunnel/tunnel.sh status

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

sdk-rust-test:  ## Format, lint, and test the Rust SDK and compile its examples
	cd sdk/rust && cargo fmt --check && cargo clippy --locked --all-targets --all-features -- -D warnings && cargo test --locked --all-features
	cd examples/rust-axum && cargo check --locked
	cd examples/rust-rmcp && cargo check --locked

linked-journey-conformance:  ## Run the shared linked-journey fixture in all four SDKs
	node --test --test-name-pattern='linked journey fixture' tests/mcp-completion-contract.test.mjs
	cd sdk/node && pnpm build && node --test --test-name-pattern='shared linked journey fixture' test/mcp-completion.test.mjs
	cd sdk/python && PYTHONPATH=src $(PYTHON) -m unittest tests.test_mcp_recorder.MCPRecorderTests.test_shared_linked_journey_fixture
	cd sdk/go && go test -run '^TestSharedLinkedJourneyFixture$$' ./...
	cd sdk/rust && cargo test --locked recorder_executes_shared_linked_journey_fixture

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
