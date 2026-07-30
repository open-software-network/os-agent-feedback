# Review — chunk 4 (backend lints) — opus

Method: I did not re-run fmt/clippy/test. For question 1 I extracted every
Rust string literal from the HEAD and working-tree versions of all eight changed
files with a hand-written Rust lexer (handles `r#*"…"#*`, `b"…"`, escapes, and
skips comments) and compared cooked values as multisets — 1257 literals before,
1270 after. Then I mechanically filtered the diff down to hunks whose content
changes survive normalising `pub`→`pub(crate)`, `r#"`→`r"`, and all whitespace:
82 hunks, which I classified individually. Findings marked [ran] / [read].

**No behavior change found.** Everything below is scope and quality.

## Blocking

None.

## Non-blocking

- **The two `float_cmp` fixes use the wrong tolerance idiom** —
  `backend/src/store.rs:2927-2928`. **[ran]**
  `summary.review_rate == 0.5` became
  `(summary.review_rate - 0.5).abs() < f64::EPSILON`. `f64::EPSILON` is the ULP
  at 1.0, not a scale-relative tolerance, so this is the cargo-cult form of the
  fix rather than a real one — at a different magnitude it would be no better
  than `==`. Harmless here on two counts: both values come out of
  `rounded_rate` (`store.rs:1076`) as exactly-representable binary fractions
  (0.5, 1.0), and both sites are inside the `#[cfg(test)]` block
  (`store.rs:2434-3489`), so no production comparison is involved. Worth
  correcting to an explicit tolerance so the pattern isn't copied into
  production code later, where it would silence `float_cmp` without actually
  making the comparison safe.

- **`dashboard_insights` carries a function-wide cast allow** —
  `backend/src/store.rs:1423-1427`, applying to the function at
  `store.rs:1428`. **[read]** The reason ("bounded dashboard percentages and
  integer-backed duration percentiles are intentionally rounded to whole-number
  metrics") is accurate for the casts present today, but the attribute covers
  the entire function body, so any cast added there in future is silently
  exempt from both `cast_possible_truncation` and `cast_precision_loss`. The
  sibling allow on `rounded_rate` (`store.rs:1072`) is fine by comparison —
  that function is five lines. Narrowing this one to the specific expressions,
  or extracting the percentile arithmetic into its own small function, would
  keep the exemption honest.

- **A SIGTERM registration failure now degrades quietly instead of crashing** —
  `backend/src/main.rs:296`. **[read]** The old code was
  `signal(SignalKind::terminate()).expect("install signal handler")`. The new
  code logs and then `std::future::pending::<()>().await`.

  To be clear about what I checked, because this is the hunk most likely to hide
  a real bug and it does not: using `pending()` is the *correct* choice. Had the
  error arm fallen through to `()`, the `select!` at `main.rs:303` would resolve
  immediately and the server would shut itself down at startup. It does not.
  The success path is byte-for-byte the same behaviour, and the same pattern is
  applied correctly to the Ctrl+C arm at `main.rs:285`.

  The residual note: production runs on Railway, where SIGTERM is how a deploy
  stops the container. Previously a failure to register would abort loudly at
  startup; now the process runs with no SIGTERM handling, logs one error line,
  and would be SIGKILLed after the grace period on every deploy — draining
  in-flight requests silently stops working. Registration only fails on fd/
  resource exhaustion, so this is remote; but if it happens it is now a quiet
  degradation rather than a crash. Consider making it fatal at startup instead
  of at signal time, or alerting on that log line.

- **One SQL literal's embedded indentation changed** —
  `backend/src/bin/provision_agent_playground.rs:192-194`. **[ran]** The
  `match` → `if let` rewrite reduced nesting by one level, and rustfmt
  re-indented the continuation lines *inside* the multi-line raw string, so the
  `INSERT INTO product_environments` text sent to Postgres lost four leading
  spaces per continuation line. SQL is whitespace-insensitive, so this is inert.

  Reporting it because of the mechanism, not this instance: de-nesting a block
  silently rewrites the contents of any multi-line raw string inside it. In this
  diff that touched exactly one literal and only its whitespace — I verified
  that across all eight files this is the **only** literal whose value changed
  at all, out of 1257 (the other value-level diffs are the new `reason = "…"`
  strings, the two `expect` messages replaced by `tracing::error!` text, and
  `"{}: {}"` → `"{status}: {message}"` from `uninlined_format_args`). But the
  next such refactor could land in a literal where whitespace matters.

- **`Duration::from_hours(1)` raises the effective toolchain floor with nothing
  declaring it** — `backend/src/main.rs:240`. **[ran]** Semantically identical
  to `from_secs(3_600)`. `backend/Cargo.toml` sets `edition = "2024"` but no
  `rust-version`, and there is no `rust-toolchain.toml`; the constructor is a
  recent stabilisation. Both toolchains in play are fine — local `rustc 1.95.0`
  compiles it and `backend/Dockerfile:1` pins `rust:1.97-bookworm` — so nothing
  is broken. A `rust-version` key would make the floor explicit rather than
  discovered by a build failure.

- **The review brief's scope statement is slightly off** — `.briefs/review-chunk-04.md:8`
  says the diff touches `backend/tests/**`. It does not (`git status` shows nine
  files, all `backend/Cargo.toml` + `backend/src/**`). `backend/tests/` holds
  `agent_instruction_probe.py`, `customer_agent_e2e.sh`, and `v2_acceptance.mjs`
  — no Rust, so clippy had nothing to say there. Noting it only so the gap isn't
  mistaken for missing work.

## Verified clean — stating plainly so these are not re-audited

- **Zero `.unwrap()` / `.expect(` / `panic!` / `todo!` / `unimplemented!`
  anywhere outside a `#[cfg(test)]` module in `backend/src/`.** **[ran]** I
  brace-matched every `#[cfg(test)] mod` block to get exact line ranges
  (`main.rs:1412-1469`, `os_accounts.rs:239-268`, `security.rs:194-250`,
  `store.rs:2434-3489`) and checked every match against them: **0 non-test
  hits** across all eight files. The brief's negative check passes with nothing
  surviving under a scoped allow, because nothing survives at all.

- **All four `unwrap_used`/`expect_used` allows sit inside test modules.**
  **[ran]** `main.rs:1414`, `os_accounts.rs:241`, `security.rs:196`,
  `store.rs:2436` — each is an inner `#![allow(…)]` at the top of one of the
  brace-matched ranges above. None is at file scope; none can reach production
  code.

- **`Cargo.toml` matches the master brief exactly, with no unsanctioned
  additions.** **[read]** All five `[lints.rust]` entries and every
  `[lints.clippy]` level are as specified; the allow list is exactly the four
  sanctioned lints plus `too_many_lines`, which carries a comment stating it is
  a deferral. Nothing else was added crate-level.

- **`rust_2018_idioms` has `priority = -1`**, as do `pedantic` and `nursery`
  (`backend/Cargo.toml:26,32,33`). **[read]** The group-override mechanism is
  therefore live, not silently inert.

- **`redundant_pub_crate` is allowed only where the conflict actually occurs.**
  **[ran]** It is on the five non-root modules (`error.rs`, `models.rs`,
  `os_accounts.rs`, `security.rs`, `store.rs`), all of which are declared as
  **private** `mod` in `main.rs:1-5` — which is exactly the condition that makes
  `pub(crate)` inside them "redundant" while `unreachable_pub` demands it.
  `main.rs` itself has **0** `pub(crate)` items and correctly does not carry the
  allow.

- **All 71 de-hashed SQL literals in `store.rs` are byte-identical.** **[ran]**
  `store.rs` went from 72 `r#"…"#` to 71 `r"…"` plus 1 retained `r#"…"#` (the
  one containing a `"`), and every content value matched. No SQL, JSON, or
  dashboard-served fragment changed. De-hashing is also compile-checked — a
  literal containing `"` cannot silently survive it — but I verified the
  contents rather than relying on that.

- **`redundant_clone` is a non-issue: the diff neither removes nor adds a single
  `.clone()`.** **[ran]** Both `git diff | grep -E '^[-+].*\.clone\(\)'`
  searches return empty, so there is no aliasing or drop-order question to
  answer.

- **Every new `try_from` propagates; none defaults to zero.** **[ran]**
  `store.rs:1244` and `store.rs:1315` introduce
  `usize::try_from(limit).map_err(ApiError::internal)?` and feed `page_size`
  into the same three uses that previously read `limit as usize` (the
  `len() > …` test, the `[… - 1]` index, and `truncate(…)`) — identical values
  on the success path, a propagated 500 instead of a silent wrap on failure.
  `store.rs:1420` replaces `(removed_interactions + removed_sessions) as u64`
  with `u64::try_from(…).map_err(ApiError::internal)`, also propagated. No row
  count can become 0.

- **The `map_or_else` argument order is correct** — `main.rs:462-465`. **[ran]**
  For `Result`, the first closure is the `Err` arm and the second the `Ok` arm;
  the code has `|_| "/?view=team&invite=invalid"` first and
  `|workspace_id| format!("/?view=team&team={workspace_id}")` second, matching
  the old `match` exactly. This is the one hunk in the diff where swapping two
  closures would have silently inverted an auth redirect, and it is right. It is
  also the only `map_or_else` introduced.

- **Both `let …  else` rewrites are exact** — `main.rs:445` and `main.rs:457`.
  **[read]** The originals were already `match { Ok(x) => x, Err(_) => return
  auth_failure(&state) }`, so the error was discarded before this chunk; the
  new `let Ok(x) = … else { return auth_failure(&state); }` preserves that,
  including the pre-existing discard. No error handling was lost here.

- **`needless_pass_by_value` did not change the MCP JSON-RPC wire format.**
  **[read]** I read each converted body rather than assuming: `mcp_ok`
  (`main.rs:1032`), `mcp_error` (`:1035`), `mcp_error_response` (`:1041`),
  `mcp_auth_error` (`:1063`) and `mcp_tool_result` (`:1021`) all interpolate
  their now-borrowed arguments through `json!` / `to_string_pretty`, and
  `Serialize for &T` produces identical output to `Serialize for T`. Likewise
  `reveal_auth_error` (`main.rs:326`) is `html.replace(…)`, which was already
  resolving to `str::replace` on the owned `String` and returning a fresh one —
  same bytes out. `append_cookie` (`:…`) just drops one `&` at the
  `HeaderValue::from_str` call.

- **`models::*` / `store::*` → explicit import lists is compile-enforced inert**
  (`main.rs`, `store.rs`). **[read]** A missing name would not build, and no
  trait is involved whose absence could silently change method resolution.
  Similarly `and_then(|db| db.code())` →
  `and_then(sqlx::error::DatabaseError::code)` (`store.rs`) is the same call.

- **No allow carries a boilerplate reason.** **[read]** All six distinct
  `reason =` strings state something specific and true about the site they guard
  (CLI stdout, binary-only crate visibility, display-only rate conversion,
  bounded dashboard percentiles, test assertion sites). None is a generic
  "needed to pass clippy".

- **The `#[cfg_attr(not(test), allow(dead_code))]` attributes on
  `store.rs:677` and `store.rs:1593` are pre-existing**, not introduced here —
  `git diff` contains no `+`/`-` line for either. **[ran]** (For the record,
  `create_product` and `dashboard` genuinely have no non-test callers; that
  predates this chunk.)

## Verdict

SHIP — a lint-only change that actually is lint-only: 1257 string literals with
exactly one whitespace-level SQL change, zero clone edits, zero unwrap/expect
left outside test modules, every new fallible cast propagated, and the two
hunks that could plausibly have broken something (the `select!` shutdown arms
and the `map_or_else` redirect) both done correctly.
