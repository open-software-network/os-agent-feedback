import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const landingHtml = await readFile(
  new URL("../landing-page/index.html", import.meta.url),
  "utf8",
);
const appHtml = await readFile(
  new URL("../landing-page/app/index.html", import.meta.url),
  "utf8",
);
const landingCss = await readFile(
  new URL("../landing-page/styles.css", import.meta.url),
  "utf8",
);

test("the static landing page contains the Epode product contract", () => {
  assert.match(landingHtml, /Epode — product feedback from customer agents/i);
  assert.match(landingHtml, /Did your product actually work for your customer/i);
  assert.match(landingHtml, /agentFeedback/);
  assert.match(landingHtml, /Node, Python, Go, Rust/i);
  assert.match(landingHtml, /language-neutral protocol/i);
  assert.match(landingHtml, /helped_with_friction/);
  assert.match(landingHtml, /strength/);
  assert.doesNotMatch(landingHtml, /OS Accounts|Open Software Account/);
  assert.doesNotMatch(
    landingHtml,
    /codex-preview|react-loading-skeleton|Building your site/i,
  );
});

// The stylesheet is the largest hand-written artifact here and is linked by
// absolute path, so a typo in the href or a lost file ships an unstyled page
// with every other assertion still green.
test("the landing page is actually styled", () => {
  assert.match(landingHtml, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(landingCss, /\.hero\b/);
  assert.match(landingCss, /@media/);
});

test("links and redirects to the canonical app origin", () => {
  assert.match(landingHtml, /https:\/\/app\.epode\.ai\/auth\/start/);
  assert.match(landingHtml, /https:\/\/docs\.epode\.ai/);
  assert.doesNotMatch(
    landingHtml,
    /agent-feedback-api-production\.up\.railway\.app/,
  );
  assert.match(
    appHtml,
    /<meta[^>]+http-equiv="refresh"[^>]+content="0;url=https:\/\/app\.epode\.ai\/auth\/start"/i,
  );
  assert.match(appHtml, /<a [^>]*href="https:\/\/app\.epode\.ai\/auth\/start"/);
  assert.match(appHtml, /<a [^>]*>[^<]+<\/a>/, "fallback link has no text");
  assert.match(appHtml, /<meta name="robots" content="noindex/);
});
