---
name: bootstrapping-project
description: Prepare an os-epode checkout for local development by invoking its idempotent Make targets, starting healthy PostgreSQL, and reporting the separate backend and web commands. Use for bootstrap, first-time setup, local project setup, or spinning up development prerequisites.
---

# Bootstrapping os-epode

Use the repository's Make targets as the source of truth. Run commands from the repository root.

## Workflow

1. Run `make dev-bootstrap` for normal setup. It installs locked dependencies and Rust tooling, creates missing environment files, starts PostgreSQL, waits for health, and exits.
2. On success, tell the developer to run `make dev-backend` and `make dev-web` in separate terminals.
3. Use `make dev-setup` when PostgreSQL should not be started, or `make dev-env` when only missing environment files should be created.

Bootstrap preserves every existing environment file. It does not enable developer authentication, generate secrets, seed data, run a separate migration command, or start the backend and web processes. Backend startup applies local migrations.

Use Docker-backed `docker-compose` with its default socket for the normal team workflow. Do not set `DOCKER_HOST` preemptively.

If the developer explicitly uses rootless Podman, select it on every Make command that manages PostgreSQL. Make rediscovers the current socket for each invocation:

```sh
make dev-bootstrap DEV_CONTAINER_RUNTIME=podman
# Later, in the backend terminal:
make dev-backend DEV_CONTAINER_RUNTIME=podman
```

Do not persist `DOCKER_HOST` or commit machine-specific socket paths, host networking, port-selection logic, or Compose overrides. If Make reports that Podman has no live rootless socket, report the runtime error instead of guessing a path.
