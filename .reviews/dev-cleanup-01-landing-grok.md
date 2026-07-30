# Review — chunk 1 (landing-page) — grok

## Blocking
- none

## Non-blocking
- bare anchors lose underlines vs original — `landing-page/styles.css:30-33` — `a { text-decoration: inherit }` is stronger than original `a { color: inherit }` (`app/globals.css:7`); footer `Sign in →` and any non-`.button` link outside the topbar ruleset no longer get browser default underline
- mono stack drops Geist — `landing-page/styles.css:205-208` vs `app/globals.css:31` — `code` was `var(--font-geist-mono), ui-monospace, monospace`; port is `ui-monospace, monospace` only (body already Arial in both)
- favicon/og not in `landing-page/` yet — `landing-page/index.html:11-12,19` — `/favicon.svg` and production `og.png` 404 until chunk 2 moves `public/` assets (explicitly deferred in `.briefs/chunk-02-prune-pnpm.md`); not a chunk-1 scope miss
- negative chrome assertions now near-tautologies — `tests/rendered-html.test.mjs:24-27` — `codex-preview|react-loading-skeleton|Building your site` guarded broken worker SSR; against hand-written static HTML they almost cannot fail. Intent kept; value dropped. Consider asserting protocol href / CTA count if you want real regression teeth later
- no assert that `styles.css` is linked or non-empty — `tests/rendered-html.test.mjs` — page can ship unstyled and still pass

## Verdict
SHIP — copy, links, `/app` meta-refresh+fallback, and prior test intent match; nits only
