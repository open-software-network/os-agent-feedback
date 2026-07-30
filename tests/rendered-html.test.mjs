import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const landingHtml = await readFile(new URL("../landing-page/index.html", import.meta.url), "utf8");
const appHtml = await readFile(new URL("../landing-page/app/index.html", import.meta.url), "utf8");
const landingCss = await readFile(new URL("../landing-page/styles.css", import.meta.url), "utf8");

test("the static landing page contains the Epode product contract", () => {
  assert.match(landingHtml, /Epode — product feedback from customer agents/i);
  assert.match(landingHtml, /Did your product actually work for your customer/i);
  assert.match(landingHtml, /agentFeedback/);
  assert.match(landingHtml, /Node, Python, Go, Rust/i);
  assert.match(landingHtml, /language-neutral protocol/i);
  assert.match(landingHtml, /helped_with_friction/);
  assert.match(landingHtml, /strength/);
  assert.doesNotMatch(landingHtml, /OS Accounts|Open Software Account/);
  assert.doesNotMatch(landingHtml, /codex-preview|react-loading-skeleton|Building your site/i);
});

// Nothing else in the repo validates this markup: Biome 2.4.12's HTML formatter
// is experimental, so landing-page/*.html sits outside biome.json's file set on
// purpose. These pages are hand-written, so tag balance is a real risk.
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function unbalancedTags(html) {
  const stack = [];
  // Skip <pre> contents: the landing page embeds JSON and code samples that
  // contain characters a naive tag scanner would misread.
  const scannable = html.replace(/<pre>[\s\S]*?<\/pre>/g, "<pre></pre>");
  for (const [, closing, name] of scannable.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
    const tag = name.toLowerCase();
    if (VOID_ELEMENTS.has(tag)) continue;
    if (closing) {
      if (stack.pop() !== tag) return `unexpected </${tag}>`;
    } else {
      stack.push(tag);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

test("the landing page markup is well formed", () => {
  for (const [name, html] of [
    ["index.html", landingHtml],
    ["app/index.html", appHtml],
  ]) {
    assert.equal(unbalancedTags(html), null, `${name} has unbalanced tags`);
    assert.match(html, /^<!doctype html>/i, `${name} is missing its doctype`);
    assert.match(html, /<meta charset="utf-8">/i, `${name} is missing charset`);
    assert.match(html, /<meta name="viewport"/i, `${name} is missing viewport`);
    assert.match(html, /<html lang="en">/i, `${name} is missing lang`);
    assert.match(html, /<title>[^<]+<\/title>/i, `${name} is missing a title`);
  }
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
  assert.doesNotMatch(landingHtml, /agent-feedback-api-production\.up\.railway\.app/);
  assert.match(
    appHtml,
    /<meta[^>]+http-equiv="refresh"[^>]+content="0;url=https:\/\/app\.epode\.ai\/auth\/start"/i,
  );
  assert.match(appHtml, /<a [^>]*href="https:\/\/app\.epode\.ai\/auth\/start"/);
  assert.match(appHtml, /<a [^>]*>[^<]+<\/a>/, "fallback link has no text");
  assert.match(appHtml, /<meta name="robots" content="noindex/);
});
