.PHONY: help install node-install backend-install node-version-check backend-fmt-check backend-clippy backend-test biome-check biome-fix node-test landing-check sdk-node-test docs-validate docs-a11y check

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

# --- Backend ---
backend-fmt-check:  ## Check backend Rust formatting
	cd backend && cargo fmt --check

backend-clippy:  ## Run strict Clippy checks for every backend target
	cd backend && cargo clippy --all-targets --locked -- -D warnings

backend-test:  ## Run the locked backend Rust test suite
	cd backend && cargo test --locked

# --- Node ---
biome-check:  ## Check formatting and linting for Biome-managed files
	pnpm check

biome-fix:  ## Apply safe formatting and lint fixes to Biome-managed files
	pnpm check:fix

node-test:  ## Run the root Node test suite
	pnpm test

# Biome only sees styles.css and package.json here — its HTML formatter is
# behind an experimental flag, so landing-page/*.html is deliberately outside
# biome.json's file set. The markup contract (copy, links, redirect, tag
# balance) is asserted by tests/rendered-html.test.mjs instead.
landing-check:  ## Check landing-page CSS formatting and the HTML markup + content contract
	pnpm exec biome check landing-page/
	node --test tests/rendered-html.test.mjs

sdk-node-test:  ## Build and test the Node SDK
	cd sdk/node && pnpm test

# --- Docs ---
docs-validate: node-version-check  ## Validate the Mintlify documentation
	pnpm run docs:validate

docs-a11y: node-version-check  ## Run Mintlify accessibility checks
	pnpm run docs:a11y

# --- Combined ---
# node-version-check runs first on purpose: the docs targets at the end hard-fail
# on Node 25+, and without the early gate that failure arrives only after a full
# cargo build and the whole Node suite.
# Do not run this with `make -j`: the backend targets serialize on cargo's build
# directory lock anyway, and concurrent pnpm targets can race on node_modules if
# the tree is stale.
check: node-version-check backend-fmt-check backend-clippy backend-test biome-check node-test landing-check sdk-node-test docs-validate docs-a11y  ## Run all backend, Node, SDK, landing-page, and docs checks
