# Review — chunk 1 (landing-page) — opus

## Blocking

None.

Copy fidelity verified mechanically, not by eye: stripping tags from
`landing-page/index.html` and JSX from `app/page.tsx` yields identical word
multisets (zero words on either side), and both `<pre><code>` blocks are
byte-identical to the `protocolCode` / `review` template literals in
`app/page.tsx:3` and `app/page.tsx:11`. All six links match
(`docs.epode.ai`, `.well-known/agent-feedback-v1.json`, three
`app.epode.ai/auth/start`, `#integration`/`#top`). Both HTML files are
tag-balanced with no mismatched or unclosed elements; both have
`<meta charset>` and viewport. `node --test tests/rendered-html.test.mjs`
passes with no `dist/`. `git status` shows only `landing-page/` +
`tests/rendered-html.test.mjs` (plus orchestrator `.briefs/`) — no scope
violations.

## Non-blocking

- **`/app` is no longer an HTTP redirect** — `landing-page/app/index.html:6`.
  `app/app/page.tsx` used Next `redirect()`, which emits a 307 with a
  `Location` header. The port emits `200` + `<meta http-equiv="refresh">`.
  Browsers are fine; `curl -I`, crawlers, and non-browser clients — i.e. the
  agents this product exists to serve — will not follow it. The brief mandated
  meta-refresh, so this is spec, but chunk 6 should add a real 308 rule at the
  Railway/host layer and keep this file as the fallback body.
  Related: that page is now indexable HTML with no `<meta name="robots"
  content="noindex">`; the Next redirect never was.

- **`styles.css` has zero test coverage** — `tests/rendered-html.test.mjs`.
  The stylesheet is the largest hand-written artifact in the chunk (298 lines)
  and nothing asserts it exists or that `index.html:29` links it. A typo in the
  `href`, or `styles.css` being lost in the chunk-2 workspace shuffle, ships a
  completely unstyled page with the suite green. Suggest: read
  `landing-page/styles.css`, assert non-empty, and assert
  `landingHtml` matches `/<link rel="stylesheet" href="\/styles\.css">/`.

- **Three negative assertions became trivially-true** —
  `tests/rendered-html.test.mjs:33-36` (`codex-preview|react-loading-skeleton|
  Building your site`) and `:49-52` (`agent-feedback-api-production.up.railway.app`).
  Against the built worker these guarded a real failure mode: the deploy
  serving a placeholder/loading shell, or a stale origin leaking through the
  render. Against a file a human typed, those strings can never appear. The
  letter of the old assertions is preserved; the intent is now untested by
  anything. Either keep them as cheap paste-guards and accept that, or move the
  "the deployed page isn't a placeholder" check into a post-deploy smoke test in
  chunk 6. Same class of problem for `assert.ok(landingHtml.length > 0)` at
  `:22` — `readFile` already throws on a missing file, so it adds nothing.

- **Geist Mono dropped from code blocks** — `landing-page/styles.css:205-208`.
  `app/globals.css:31` was `font-family: var(--font-geist-mono), ui-monospace,
  monospace`; the port is `ui-monospace, monospace`. Unavoidable without
  `next/font`, and it only affects the two `<pre>` blocks, but it is a real
  visual delta, not a no-op port. (Body/sans is unaffected — `app/globals.css:6`
  already hardcoded Arial, so the Geist Sans variable was never load-bearing.)

- **`og:image` hardcoded to prod** — `landing-page/index.html:19`.
  `app/layout.tsx:11-16` derived `metadataBase` from `x-forwarded-host`, so OG
  images resolved per-host. The static port pins `https://epode.ai/og.png`, so
  any preview/staging deploy will advertise the production image. Acceptable
  for a single-origin marketing page; flagging because it is a silent behavior
  change, not a transcription.

- **Referenced assets don't exist under `landing-page/`** —
  `landing-page/index.html:11-12` (`/favicon.svg`) and `:19` (`/og.png`). Both
  currently live in root `public/`. `.briefs/chunk-02-prune-pnpm.md` explicitly
  schedules the move, so this is sequenced, not missed — noting it so it does
  not fall through the gap between chunks.

- **Tailwind preflight port is near-complete but drops
  `-webkit-text-size-adjust: 100%`** — `landing-page/styles.css:18-21`.
  Everything else load-bearing was reproduced correctly (box-sizing, universal
  margin/padding/border reset, `html { line-height: 1.5 }`, `a { text-decoration:
  inherit }`, heading `font-size`/`font-weight: inherit`, `list-style: none` —
  that last one matters, the `.integration` list is intentionally bulletless and
  the port kept it). The missing text-size-adjust lets mobile Safari auto-inflate
  body text on rotate. One line. The other omissions (`b/strong`, `img/svg`,
  form controls, `table`, `hr`) are all unreachable on this page.

- **Redirect assertion is formatting-brittle** —
  `tests/rendered-html.test.mjs:53-60`. `/<a href="https:\/\/app\.epode\.ai\/auth\/start">[^<]+<\/a>/`
  breaks if anyone adds a `class`, reorders attributes, or reformats. Prefer two
  looser assertions (URL present; anchor text non-empty).

- **Dark mode: nothing was lost.** `app/globals.css` had no
  `prefers-color-scheme` block and `app/page.tsx` had no `dark:` utilities — the
  original was light-only. Recording this so the brief's question is answered
  and nobody re-audits it.

- **`landing-page/` has no static-serving config.** The master brief deploys it
  via `railway up` to the `epode` service. With a `package.json` carrying no
  scripts and no deps, railpack has nothing to detect, and `/styles.css`,
  `/favicon.svg`, plus the `/app` → `app/index.html` directory-index resolution
  all assume doc root is `landing-page/`. Chunk 6 owns the workflow, so this is
  correctly out of chunk 1's scope — but the deploy target is currently unproven
  and nothing in chunks 2–5 will surface it.

## Verdict

SHIP — copy, links, markup, and structure are a faithful and verified port with
no blocking defects; the notable gaps are the `/app` redirect losing its HTTP
status code and `styles.css` having no test coverage, both of which are better
fixed in the chunk they belong to than by reopening chunk 1.
