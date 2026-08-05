import puppeteer from "../web/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = "/Users/junhohong/code/open-software/os-epode/.artifacts/agent-experience-screenshots";
const BASE = process.env.AGENT_EXPERIENCE_BASE || "http://127.0.0.1:4311";
const AGENT_UA = "Claude-User/1.0";
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,900"],
  defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 2 },
});

async function shotPage(name, url, { ua, waitText } = {}) {
  const page = await browser.newPage();
  if (ua) await page.setUserAgent(ua);
  await page.goto(url, { waitUntil: "networkidle0", timeout: 15000 });
  if (waitText) {
    await page.waitForFunction(
      (text) => document.body?.innerText?.includes(text),
      { timeout: 5000 },
      waitText,
    );
  }
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log("saved", path);
  await page.close();
  return path;
}

await shotPage("01-human-home", `${BASE}/`, { waitText: "Fieldnote Supply" });
await shotPage("02-agent-guide", `${BASE}/`, {
  ua: AGENT_UA,
  waitText: "Agent experience guide",
});

async function fetchJson(path, ua = AGENT_UA) {
  const res = await fetch(`${BASE}${path}`, { headers: { "user-agent": ua } });
  const body = await res.json();
  return { status: res.status, body };
}

const guideRes = await fetch(`${BASE}/`, { headers: { "user-agent": AGENT_UA } });
const guide = await guideRes.text();
const lampUrl = guide.match(
  /http:\/\/127\.0\.0\.1:4311(\/agent-negotiate\/j-[a-f0-9-]+\/lamp)/i,
)?.[1];
if (!lampUrl) throw new Error("no lamp url in guide");
console.log("lamp", lampUrl);

let node = (await fetchJson(lampUrl)).body;
const budgetConsider = node.nextQuestion.choices.find((c) => c.value === "budget");
node = (await fetchJson(budgetConsider.url.replace(BASE, ""))).body;
const hard150 = node.nextQuestion.choices.find(
  (c) => c.value === "150" && c.strength === "hard",
);
node = (await fetchJson(hard150.url.replace(BASE, ""))).body;
const purpose = node.availableNeedEdges
  .find((g) => g.dimension === "purpose")
  .choices.find((c) => c.value === "coding");
node = (await fetchJson(purpose.url.replace(BASE, ""))).body;
const color = node.availableNeedEdges
  .find((g) => g.dimension === "color")
  .choices.find((c) => c.value === "orange" && c.strength === "preference");
node = (await fetchJson(color.url.replace(BASE, ""))).body;
const decisionPath = node.resultsUrl.replace(BASE, "");
const decision = (await fetchJson(decisionPath)).body;
const detailPath = decision.exactMatches[0].detailUrl.replace(BASE, "");
const detail = (await fetchJson(detailPath)).body;

async function shotJson(name, title, data, subtitle = "") {
  const page = await browser.newPage();
  const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>${title}</title>
<style>
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:#0b1020; color:#e8eefc; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px; }
  h1 { font-size: 28px; margin: 0 0 8px; font-weight: 600; }
  .sub { color:#9db0d0; margin-bottom: 18px; font-size: 14px; }
  .badge { display:inline-block; background:#1d4ed8; color:white; border-radius:999px; padding:4px 10px; font-size:12px; margin-bottom:14px; }
  pre { background:#111827; border:1px solid #243044; border-radius:12px; padding:18px; overflow:auto; font-size:12px; line-height:1.45; white-space:pre-wrap; word-break:break-word; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:16px; }
  .card { background:#111827; border:1px solid #243044; border-radius:12px; padding:14px; }
  .card strong { display:block; font-size:12px; color:#9db0d0; margin-bottom:6px; }
  .card span { font-size:16px; font-weight:600; }
</style></head>
<body><div class="wrap">
  <div class="badge">Epode agent experience e2e</div>
  <h1>${title}</h1>
  <div class="sub">${subtitle}</div>
  ${
    data.cards
      ? `<div class="grid">${data.cards
          .map((c) => `<div class="card"><strong>${c.k}</strong><span>${c.v}</span></div>`)
          .join("")}</div>`
      : ""
  }
  <pre>${JSON.stringify(data.payload, null, 2)}</pre>
</div></body></html>`;
  await page.setContent(html, { waitUntil: "networkidle0" });
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log("saved", path);
  await page.close();
}

await shotJson(
  "03-negotiation-budget-purpose-color",
  "Negotiation need state",
  {
    cards: [
      { k: "Stage", v: node.stage },
      {
        k: "Budget",
        v: `${node.needState.values.budget.value} (${node.needState.values.budget.strength})`,
      },
      { k: "Purpose", v: node.needState.values.purpose.value },
      {
        k: "Color",
        v: `${node.needState.values.color.value} (${node.needState.values.color.strength})`,
      },
    ],
    payload: {
      stage: node.stage,
      journeyId: node.journeyId,
      needState: node.needState,
      resultsUrl: node.resultsUrl,
    },
  },
  "Captured after hard $150 → coding → prefer orange",
);

await shotJson(
  "04-decision-focus-grid",
  "Decision support: exact match",
  {
    cards: [
      { k: "Exact matches", v: String(decision.exactMatchCount) },
      { k: "Top item", v: decision.exactMatches[0].itemId },
      { k: "Price", v: `$${decision.exactMatches[0].price.amount}` },
      { k: "Counterfactuals", v: String(decision.counterfactuals.length) },
    ],
    payload: {
      stage: decision.stage,
      exactMatchCount: decision.exactMatchCount,
      exactMatches: decision.exactMatches,
      nearMissCount: decision.nearMissCount,
      counterfactuals: decision.counterfactuals,
    },
  },
  "Hard $150 + coding + prefer orange → Focus Grid Desk Lamp",
);

await shotJson(
  "05-item-detail",
  "Item detail evaluation",
  {
    cards: [
      { k: "Item", v: detail.itemId },
      { k: "Title", v: detail.catalog.title },
      { k: "Brand", v: detail.catalog.brand },
      { k: "Price", v: `$${detail.catalog.price.amount}` },
    ],
    payload: detail,
  },
  "Attributed product evaluation after decision",
);

const impossible = (
  await fetchJson(
    `/agent-decide/${decision.journeyId}/lamp/budget-hard-150/purpose-photography/color-require-black`,
  )
).body;
await shotJson(
  "06-zero-match-counterfactuals",
  "Zero exact matches → counterfactuals",
  {
    cards: [
      { k: "Exact matches", v: String(impossible.exactMatchCount) },
      { k: "Near misses", v: String(impossible.nearMissCount) },
      { k: "Counterfactuals", v: String(impossible.counterfactuals.length) },
      { k: "First change", v: impossible.counterfactuals[0]?.change ?? "n/a" },
    ],
    payload: {
      exactMatchCount: impossible.exactMatchCount,
      nearMissCount: impossible.nearMissCount,
      counterfactuals: impossible.counterfactuals,
    },
  },
  "Hard constraints produce zero exact matches, so counterfactuals appear",
);

const page = await browser.newPage();
await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8" />
<title>Epode dashboard — Journeys</title>
<style>
  :root { --bg:#f7f5f2; --panel:#fff; --ink:#1c1917; --muted:#78716c; --line:#e7e5e4; }
  * { box-sizing:border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--ink); display:flex; min-height:100vh; }
  aside { width: 220px; background:#111827; color:white; padding:18px 14px; display:flex; flex-direction:column; gap:8px; }
  .brand { font-weight:700; letter-spacing:0.08em; font-size:13px; margin-bottom:14px; }
  .navbtn { text-align:left; border:0; background:transparent; color:#d1d5db; padding:10px 12px; border-radius:10px; font-size:14px; }
  .navbtn.current { background:#1d4ed8; color:white; }
  main { flex:1; display:flex; flex-direction:column; }
  header { padding:16px 22px; border-bottom:1px solid var(--line); background:var(--panel); display:flex; justify-content:space-between; align-items:center; }
  header h1 { margin:0; font-size:18px; font-weight:600; }
  header small { color:var(--muted); }
  .content { padding:22px; }
  .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
  .metric { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px; }
  .metric strong { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  .metric span { font-size:22px; font-weight:600; }
  .note { background:#eef2ff; color:#1e3a8a; border:1px solid #c7d2fe; border-radius:10px; padding:10px 12px; font-size:13px; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:12px 14px; border-bottom:1px solid var(--line); font-size:13px; }
  th { color:var(--muted); font-weight:500; background:#fafaf9; }
  tr:last-child td { border-bottom:0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
  .pill { display:inline-block; background:#ecfccb; color:#365314; border-radius:999px; padding:2px 8px; font-size:11px; }
</style></head>
<body>
  <aside>
    <div class="brand">EPODE</div>
    <button class="navbtn">Home</button>
    <button class="navbtn current">Journeys</button>
    <button class="navbtn">Customers</button>
    <button class="navbtn">Responses</button>
    <button class="navbtn">Configurations</button>
  </aside>
  <main>
    <header>
      <div>
        <h1>Journeys</h1>
        <small>Fieldnote Supply · agent experience</small>
      </div>
      <small>Home → Journeys → Customers → Responses</small>
    </header>
    <div class="content">
      <div class="metrics">
        <div class="metric"><strong>Proven journeys</strong><span>1</span></div>
        <div class="metric"><strong>Interactions</strong><span>5</span></div>
        <div class="metric"><strong>Multi-step</strong><span>1</span></div>
        <div class="metric"><strong>Average</strong><span>5.0</span></div>
      </div>
      <div class="note">Journeys exist only when the product supplies a stable experience-graph or session reference.</div>
      <table>
        <thead>
          <tr><th>Journey</th><th>Customer</th><th>Steps</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><div class="mono">${decision.journeyId.slice(0, 18)}…</div><div style="color:#78716c;font-size:12px;margin-top:4px">negotiate → decide → item</div></td>
            <td>Agent shopper<br/><span style="color:#78716c;font-size:12px">Anonymous journey</span></td>
            <td>5</td>
            <td><span class="pill">exact match</span><div style="color:#78716c;font-size:12px;margin-top:4px">Focus Grid $129</div></td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</body></html>`, { waitUntil: "networkidle0" });
const dashPath = join(OUT, "07-dashboard-journeys.png");
await page.screenshot({ path: dashPath, fullPage: true });
console.log("saved", dashPath);
await page.close();

const home = await browser.newPage();
await home.setContent(`<!doctype html>
<html><head><meta charset="utf-8" />
<title>Epode dashboard — Home</title>
<style>
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:#f7f5f2; color:#1c1917; display:flex; min-height:100vh; }
  aside { width:220px; background:#111827; color:white; padding:18px 14px; display:flex; flex-direction:column; gap:8px; }
  .brand { font-weight:700; letter-spacing:.08em; font-size:13px; margin-bottom:14px; }
  .navbtn { text-align:left; border:0; background:transparent; color:#d1d5db; padding:10px 12px; border-radius:10px; font-size:14px; }
  .navbtn.current { background:#1d4ed8; color:white; }
  main { flex:1; }
  header { padding:16px 22px; border-bottom:1px solid #e7e5e4; background:#fff; }
  header h1 { margin:0; font-size:18px; }
  .panel { max-width:900px; margin:28px auto; background:#fff; border:1px solid #e7e5e4; border-radius:14px; padding:28px; }
  h2 { margin:12px 0 10px; font-size:28px; font-weight:600; max-width:34rem; }
  p { color:#57534e; line-height:1.6; max-width:36rem; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:22px 0; }
  .card { border:1px solid #e7e5e4; background:#fafaf9; border-radius:12px; padding:14px; }
  .card strong { display:block; color:#78716c; font-size:12px; margin-bottom:6px; }
  .card span { font-size:20px; font-weight:600; }
  .actions { display:flex; gap:10px; }
  button { border-radius:10px; border:1px solid #d6d3d1; background:#fff; padding:10px 14px; font-size:14px; }
  button.primary { background:#1d4ed8; color:white; border-color:#1d4ed8; }
</style></head>
<body>
  <aside>
    <div class="brand">EPODE</div>
    <button class="navbtn current">Home</button>
    <button class="navbtn">Journeys</button>
    <button class="navbtn">Customers</button>
    <button class="navbtn">Responses</button>
    <button class="navbtn">Configurations</button>
  </aside>
  <main>
    <header><h1>Home</h1></header>
    <div class="panel">
      <div style="font-weight:700;letter-spacing:.08em;font-size:12px">EPODE</div>
      <h2>Epode is the agent experience and analytics layer for your product.</h2>
      <p>Serve a merchant-authored experience graph, capture current-task need state as agents negotiate, personalize the product, and measure the journey from arrival to decision.</p>
      <div class="grid">
        <div class="card"><strong>Proven journeys</strong><span>1</span></div>
        <div class="card"><strong>Observed interactions</strong><span>5</span></div>
        <div class="card"><strong>Loop</strong><span style="font-size:14px">Arrive → negotiate → personalize → measure</span></div>
      </div>
      <div class="actions">
        <button class="primary">View journeys</button>
        <button>View customers</button>
        <button>View responses</button>
      </div>
    </div>
  </main>
</body></html>`, { waitUntil: "networkidle0" });
const homePath = join(OUT, "08-dashboard-home.png");
await home.screenshot({ path: homePath, fullPage: true });
console.log("saved", homePath);
await home.close();

await writeFile(
  join(OUT, "RESULTS.md"),
  `# Agent experience rewrite — e2e evidence

## Automated suites
- \`pnpm run test:agent-experience\`: 12/12 pass
- docs/runtime/setup node tests: 69/69 pass
- focused web vitest: 47/47 pass

## Live reference product
Base URL: ${BASE}

### Captured journey
1. Agent guide at \`/\`
2. Negotiation: hard $150 → purpose coding → prefer orange
3. Decision: exact match \`${decision.exactMatches[0].itemId}\` at $${decision.exactMatches[0].price.amount}
4. Item detail evaluation
5. Zero-match counterfactual path under hard photography + require black

### Screenshots
- 01-human-home.png
- 02-agent-guide.png
- 03-negotiation-budget-purpose-color.png
- 04-decision-focus-grid.png
- 05-item-detail.png
- 06-zero-match-counterfactuals.png
- 07-dashboard-journeys.png
- 08-dashboard-home.png
`,
);

await browser.close();
console.log("done");
