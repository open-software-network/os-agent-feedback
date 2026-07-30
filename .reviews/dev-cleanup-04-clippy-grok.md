# Review — chunk 4 (backend lints) — grok

## Blocking
- none

## Non-blocking
- shutdown signal install failure no longer panics — `backend/src/main.rs` `shutdown_signal` — was `.expect("install Ctrl+C handler")` / `.expect("install signal handler")`; now logs + `pending::<()>()` so that arm never completes. Happy path identical; only changes a pathological install-failure path (server keeps running without that signal). Intentional `expect_used` fix, not a wrong default. [read]
- retention interval rewrite — `backend/src/main.rs` `spawn_retention_worker` — `Duration::from_secs(3_600)` → `from_hours(1)`; equivalent duration, clippy-style sugar. [read]
- pagination `i64`→`usize` via `try_from` — `backend/src/store.rs` `feedback_list_reports` / `feedback_list_interactions` — `page_size = usize::try_from(limit).map_err(ApiError::internal)?` then index/truncate. `feedback_limit` already clamps `1..=100`, so `Err` is dead on real inputs; no silent `0`. Same for purge `u64::try_from(sum).map_err(ApiError::internal)` vs old `as u64`. [read]
- float_cmp (2 sites) only in tests — `backend/src/store.rs` cfg(test): `summary.review_rate == 0.5` → `(x - 0.5).abs() < f64::EPSILON` (and confirmation_rate). Production `rounded_rate` unchanged aside from scoped `cast_precision_loss` allow. [read]
- raw-string de-hash 77 sites — no dehashed `r"..."` content contains `"` (scan of diff). Literals that still need quotes stay `r#"..."#` (e.g. HTML auth-error snippets in `main.rs` tests, multi-line SQL with embedded quotes where required). SQL/JSON text unchanged in spirit; mechanical. [ran]
- control-flow sugar equivalent — `auth_callback` `let Ok … else { auth_failure }`, invite `map_or_else`, provision bin `if let Some`/`else` vs `match` — same Ok/Err/None branches. [read]
- needless-pass-by-value → refs — `mcp_ok`/`mcp_error`/`mcp_tool_result`/`append_cookie`/`reveal_auth_error` take `&Value`/`&str`; serialization and Set-Cookie bytes unchanged. [read]
- no production `.unwrap()`/`.expect(` left outside `#[cfg(test)]` modules (stripped-module scan). Survivors only under test `#![allow(unwrap_used, expect_used)]` in `main.rs`/`store.rs`/`security.rs`/`os_accounts.rs`. [ran]
- crate-level `[lints]` extras — only `too_many_lines = "allow"` beyond the four brief-sanctioned allows; comment records deferral. Matches master brief + orchestrator sanction. `rust_2018_idioms = { level = "warn", priority = -1 }` present. Aligns with os-platform aside from single-crate `[lints]` vs `[workspace.lints]` and no `missing_docs` allow (not required). [read]
- file-level `clippy::redundant_pub_crate` — `error.rs`/`models.rs`/`os_accounts.rs`/`security.rs`/`store.rs` with reason about `unreachable_pub` conflict in binary-only crate. Appropriate breadth given mass `pub`→`pub(crate)`. Not on bins/`main.rs` (no conflict there). [read]
- scoped cast allows — `rounded_rate` (`cast_precision_loss`); `dashboard_insights` (`cast_possible_truncation` + `cast_precision_loss`) with display-metrics reasons. Still uses `as f64`/`as i64` for rates/percentiles — same as before, just annotated. [read]
- bin print allows — `provision_agent_playground.rs` stdout+stderr (uses both); `setup_matrix_db.rs` stdout only (only `println!`). Reasons accurate. [read]
- test unwrap allows — module-level inside `#[cfg(test)]` only; reasons “abort at assertion site”. Not leaked to prod modules. [read]
- `backend/public` + `backend/migrations` — `git diff --stat` empty. [ran]
- no `// clippy::` noise / no crate-wide unwrap allow. [read]

## Behavior audit summary
Mechanical: `pub`→`pub(crate)`, import/format, raw-string hash strip, ref-passing. Semantic fixes reviewed: casts fail closed via `ApiError::internal` rather than truncate; float compares only in tests; auth/MCP/cookie paths preserve status and payloads. No swallowed errors into `unwrap_or_default` on critical paths; existing `unwrap_or_default` on optional cookies/strings pre-existed. [read]

## Not re-run
- `cargo fmt` / `clippy -D warnings` / `cargo test` — orchestrator already green (10 pass / 5 ignore).

## Verdict
SHIP — lint policy matches brief; production panic paths removed without quiet wrong defaults; no wire/SQL behavior changes found.
