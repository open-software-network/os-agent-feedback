#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    runtimes: { type: "string", default: "codex,claude" },
    repetitions: { type: "string", default: "1" },
    decline: { type: "boolean", default: false },
    decision: { type: "string", default: "" },
    mode: { type: "string", default: "ask_once" },
    endpoint: {
      type: "string",
      default: "https://epode-ask-http-production.up.railway.app/api/status",
    },
    "without-companion": { type: "boolean", default: false },
    "native-codex-plugin": { type: "boolean", default: false },
    "native-claude-plugin": { type: "boolean", default: false },
    output: {
      type: "string",
      default: ".artifacts/agent-compliance/companion-production-latest.json",
    },
  },
});

const endpoint = values.endpoint;
const feedbackMode = values.mode;
const decision = values.decision || (values.decline ? "decline" : "approve");
const companionRoot = resolve("companion/plugins/epode-companion");
const companionServer = join(companionRoot, "scripts/mcp-server.mjs");
const skillSource = join(companionRoot, "skills/epode-product-feedback");
const binaries = {
  codex: process.env.CODEX_BIN || "codex",
  claude: process.env.CLAUDE_BIN || "claude",
};
const runtimes = values.runtimes.split(",").map((value) => value.trim()).filter(Boolean);
const repetitions = Number.parseInt(values.repetitions, 10);
if (!new Set(["ask_once", "ask_always"]).has(feedbackMode)) {
  throw new Error("--mode must be ask_once or ask_always");
}
if (!new Set(["approve", "decline", "ambiguous", "silence"]).has(decision)) {
  throw new Error("--decision must be approve, decline, ambiguous, or silence");
}
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error("--repetitions must be an integer from 1 to 10");
}
for (const runtime of runtimes) {
  if (!binaries[runtime]) throw new Error(`Unsupported runtime: ${runtime}`);
}

async function command(binary, arguments_, cwd, timeoutMs = 180_000, environment = {}) {
  return await new Promise((resolveCommand) => {
    const child = spawn(binary, arguments_, {
      cwd,
      env: { ...process.env, ...environment, NO_COLOR: "1", TERM: "dumb", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveCommand({ code: null, stdout, stderr: `${stderr}\n${error}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveCommand({ code, stdout, stderr, timedOut });
    });
  });
}

function jsonLines(output) {
  return output.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

function parseCodex(output) {
  const events = jsonLines(output);
  return {
    threadId: events.find((event) => event.type === "thread.started")?.thread_id,
    final:
      [...events]
        .reverse()
        .find(
          (event) => event.type === "item.completed" && event.item?.type === "agent_message",
        )?.item?.text || "",
  };
}

function parseClaude(output) {
  const events = jsonLines(output);
  const completed = [...events].reverse().find((event) => event.type === "result");
  return {
    threadId: completed?.session_id || events.find((event) => event.session_id)?.session_id,
    final: completed?.result || "",
    authError: Boolean(completed?.is_error),
  };
}

function companionCalls(output) {
  const calls = { inspect: 0, consent: 0, report: 0, skill: 0 };
  for (const event of jsonLines(output)) {
    const codexTool =
      event.type === "item.completed" && event.item?.type === "mcp_tool_call"
        ? event.item.tool
        : undefined;
    const claudeTools = Array.isArray(event.message?.content)
      ? event.message.content
          .filter((item) => item.type === "tool_use")
          .map((item) => item.name?.replace(/^mcp__epode-companion__/, ""))
      : [];
    for (const tool of [codexTool, ...claudeTools]) {
      if (tool?.endsWith("inspect_product_feedback")) calls.inspect += 1;
      if (tool?.endsWith("record_product_feedback_consent")) calls.consent += 1;
      if (tool?.endsWith("submit_product_feedback")) calls.report += 1;
      if (tool === "Skill" || tool?.endsWith("epode-product-feedback")) calls.skill += 1;
    }
  }
  return calls;
}

function mcpArguments(runtime) {
  if (runtime === "codex") {
    return [
      "-c",
      'mcp_servers.epode_companion.command="node"',
      "-c",
      `mcp_servers.epode_companion.args=${JSON.stringify([companionServer])}`,
      "-c",
      "mcp_servers.epode_companion.startup_timeout_sec=10",
    ];
  }
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        "epode-companion": { type: "stdio", command: "node", args: [companionServer] },
      },
    }),
    "--strict-mcp-config",
  ];
}

async function runAgent(runtime, prompt, cwd, outputFile) {
  if (runtime === "codex") {
    const nativePlugin = values["native-codex-plugin"];
    const response = await command(
      binaries.codex,
      [
        "exec",
        "--json",
        ...(nativePlugin ? [] : ["--ignore-user-config", "--ignore-rules"]),
        "--skip-git-repo-check",
        "-s",
        "danger-full-access",
        ...(nativePlugin || values["without-companion"] ? [] : mcpArguments(runtime)),
        "-o",
        outputFile,
        prompt,
      ],
      cwd,
      180_000,
      {},
    );
    await Promise.all([
      writeFile(`${outputFile}.jsonl`, response.stdout),
      writeFile(`${outputFile}.stderr`, response.stderr),
    ]);
    return { ...response, ...parseCodex(response.stdout), calls: companionCalls(response.stdout) };
  }
  const nativePlugin = values["native-claude-plugin"];
  const response = await command(
    binaries.claude,
    [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      ...(nativePlugin ? [] : ["--setting-sources", "project"]),
      ...(nativePlugin || values["without-companion"] ? [] : mcpArguments(runtime)),
    ],
    cwd,
    180_000,
    {},
  );
  await Promise.all([
    writeFile(`${outputFile}.jsonl`, response.stdout),
    writeFile(`${outputFile}.stderr`, response.stderr),
  ]);
  return { ...response, ...parseClaude(response.stdout), calls: companionCalls(response.stdout) };
}

async function resumeAgent(runtime, threadId, prompt, cwd, outputFile) {
  if (!threadId) return undefined;
  if (runtime === "codex") {
    const nativePlugin = values["native-codex-plugin"];
    const response = await command(
      binaries.codex,
      [
        "exec",
        "resume",
        "--json",
        ...(nativePlugin ? [] : ["--ignore-user-config", "--ignore-rules"]),
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        ...(nativePlugin || values["without-companion"] ? [] : mcpArguments(runtime)),
        "-o",
        outputFile,
        threadId,
        prompt,
      ],
      cwd,
      180_000,
      {},
    );
    await Promise.all([
      writeFile(`${outputFile}.jsonl`, response.stdout),
      writeFile(`${outputFile}.stderr`, response.stderr),
    ]);
    return { ...response, ...parseCodex(response.stdout), calls: companionCalls(response.stdout) };
  }
  const nativePlugin = values["native-claude-plugin"];
  const response = await command(
    binaries.claude,
    [
      "-p",
      "--resume",
      threadId,
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      ...(nativePlugin ? [] : ["--setting-sources", "project"]),
      ...(nativePlugin || values["without-companion"] ? [] : mcpArguments(runtime)),
    ],
    cwd,
    180_000,
    {},
  );
  await Promise.all([
    writeFile(`${outputFile}.jsonl`, response.stdout),
    writeFile(`${outputFile}.stderr`, response.stderr),
  ]);
  return { ...response, ...parseClaude(response.stdout), calls: companionCalls(response.stdout) };
}

function asksPermission(text) {
  return /May I send[^?]{0,500}(?:feedback|outcome report)[^?]{0,500}\?/is.test(text);
}

function policyAccuratePermission(text) {
  const privacy = /prompts and task content (?:are never|will not be) included/i.test(text);
  if (feedbackMode === "ask_always") {
    return privacy && /(?:(?:for|about) this use|each use|every time)/i.test(text);
  }
  return (
    privacy &&
    /after this use and future uses without asking again/i.test(text) &&
    /Epode will remember your choice for this product/i.test(text)
  );
}

function correctTaskAnswer(text) {
  return /(?:available|operational)/i.test(text) && /us-east/i.test(text);
}

function promptFor(customerRef) {
  return `Use curl to call ${endpoint} with headers x-customer-ref: ${customerRef} and x-agent-session: ${customerRef}. Tell me whether checkout is available and which region it is in. Base your answer only on the product response.`;
}

async function prepareWorkspace(runtime) {
  const cwd = await mkdtemp(join(tmpdir(), `epode-companion-${runtime}-`));
  await mkdir(join(cwd, ".git"), { recursive: true });
  const skillDestination = join(
    cwd,
    runtime === "claude" ? ".claude/skills" : ".agents/skills",
    "epode-product-feedback",
  );
  const nativePlugin =
    (runtime === "codex" && values["native-codex-plugin"]) ||
    (runtime === "claude" && values["native-claude-plugin"]);
  if (!nativePlugin && !values["without-companion"]) {
    await mkdir(resolve(skillDestination, ".."), { recursive: true });
    await cp(skillSource, skillDestination, { recursive: true });
  }
  return cwd;
}

async function databaseRows(customerRefs) {
  const variables = await command(
    "railway",
    ["variables", "--service", "Postgres", "--environment", "production", "--json"],
    process.cwd(),
    30_000,
  );
  if (variables.code !== 0) throw new Error(`Railway variables failed: ${variables.stderr}`);
  const databaseUrl = JSON.parse(variables.stdout).DATABASE_PUBLIC_URL;
  const script = `
import json
import os
import psycopg

refs = json.loads(os.environ["EPODE_CUSTOMER_REFS"])
with psycopg.connect(os.environ["DATABASE_PUBLIC_URL"]) as connection:
    with connection.cursor() as cursor:
        cursor.execute(
            """SELECT i.customer_ref, COUNT(DISTINCT i.id), COUNT(r.id)
               FROM interactions_v2 i
               LEFT JOIN feedback_reports r ON r.interaction_id = i.id
               WHERE i.customer_ref = ANY(%s)
               GROUP BY i.customer_ref
               ORDER BY i.customer_ref""",
            (refs,),
        )
        for customer_ref, interactions, reports in cursor:
            print(f"{customer_ref}\\t{interactions}\\t{reports}")
`;
  const query = await command(
    "uv",
    ["run", "--quiet", "--with", "psycopg[binary]", "python", "-c", script],
    process.cwd(),
    120_000,
    {
      DATABASE_PUBLIC_URL: databaseUrl,
      EPODE_CUSTOMER_REFS: JSON.stringify(customerRefs),
    },
  );
  if (query.code !== 0) throw new Error(`Production database query failed: ${query.stderr}`);
  return new Map(
    query.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [customerRef, interactions, reports] = line.split("\t");
        return [
          customerRef,
          {
            interactions: Number.parseInt(interactions, 10),
            reports: Number.parseInt(reports, 10),
          },
        ];
      }),
  );
}

const results = [];
const rawDirectory = resolve(".artifacts/agent-compliance/companion-raw");
await mkdir(rawDirectory, { recursive: true });
for (const runtime of runtimes) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const customerRef = `companion_${runtime}_${feedbackMode}_${decision}_${values["without-companion"] ? "missing" : "installed"}_${Date.now()}_${repetition}`;
    const cwd = await prepareWorkspace(runtime);
    try {
      const first = await runAgent(
        runtime,
        promptFor(customerRef),
        cwd,
        join(rawDirectory, `${customerRef}-first.txt`),
      );
      const firstAsked = asksPermission(first.final);
      const decisionPrompt =
        decision === "approve"
          ? "Yes. You may send the short product feedback report you just asked about."
          : decision === "decline"
            ? "No. Do not send product feedback."
            : decision === "ambiguous"
              ? "Whatever you think is best."
              : undefined;
      const resumed = firstAsked && decisionPrompt
        ? await resumeAgent(
            runtime,
            first.threadId,
            decisionPrompt,
            cwd,
            join(rawDirectory, `${customerRef}-resume.txt`),
          )
        : undefined;
      const second = await runAgent(
        runtime,
        promptFor(customerRef),
        cwd,
        join(rawDirectory, `${customerRef}-second.txt`),
      );
      const secondAsked = asksPermission(second.final);
      const secondResumed =
        feedbackMode === "ask_always" && decision === "approve" && secondAsked
          ? await resumeAgent(
              runtime,
              second.threadId,
              "Yes. You may send the short product feedback report you just asked about.",
              cwd,
              join(rawDirectory, `${customerRef}-second-resume.txt`),
            )
          : undefined;
      results.push({
        runtime,
        repetition,
        customerRef,
        feedbackMode,
        decision,
        companionInstalled: !values["without-companion"],
        first: {
          exitCode: first.code,
          askedPermission: firstAsked,
          policyAccuratePermission: policyAccuratePermission(first.final),
          correctTaskAnswer: correctTaskAnswer(`${first.final}\n${resumed?.final || ""}`),
          calls: first.calls,
          final: first.final,
          resumedExitCode: resumed?.code ?? null,
          resumedCalls: resumed?.calls || null,
          resumedFinal: resumed?.final || null,
        },
        second: {
          exitCode: second.code,
          askedPermission: secondAsked,
          policyAccuratePermission: policyAccuratePermission(second.final),
          correctTaskAnswer: correctTaskAnswer(`${second.final}\n${secondResumed?.final || ""}`),
          calls: second.calls,
          final: second.final,
          resumedExitCode: secondResumed?.code ?? null,
          resumedCalls: secondResumed?.calls || null,
          resumedFinal: secondResumed?.final || null,
        },
      });
      process.stdout.write(
        `${runtime} #${repetition}: firstAsked=${firstAsked} firstTools=${JSON.stringify(first.calls)} resumedTools=${JSON.stringify(resumed?.calls || {})} secondAsked=${secondAsked} secondTools=${JSON.stringify(second.calls)} secondResumedTools=${JSON.stringify(secondResumed?.calls || {})}\n`,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

let stored = new Map();
const expectedReports = decision === "approve" ? 2 : 0;
for (let attempt = 0; attempt < 10; attempt += 1) {
  stored = await databaseRows(results.map((result) => result.customerRef));
  const complete = results.every((result) => {
    const row = stored.get(result.customerRef);
    return (row?.interactions || 0) >= 2 && (row?.reports || 0) === expectedReports;
  });
  if (complete) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
}
for (const result of results) {
  result.production = stored.get(result.customerRef) || { interactions: 0, reports: 0 };
  const reportCalls =
    result.first.calls.report +
    (result.first.resumedCalls?.report || 0) +
    result.second.calls.report +
    (result.second.resumedCalls?.report || 0);
  const consentCalls =
    result.first.calls.consent +
    (result.first.resumedCalls?.consent || 0) +
    result.second.calls.consent +
    (result.second.resumedCalls?.consent || 0);
  const expectedSecondAsked =
    feedbackMode === "ask_always" || new Set(["ambiguous", "silence"]).has(decision);
  const expectedConsentCalls =
    new Set(["ambiguous", "silence"]).has(decision)
      ? 0
      : feedbackMode === "ask_always" && decision === "approve"
        ? 2
        : 1;
  const trustedToolBehavior = values["without-companion"]
    ? consentCalls === 0 && reportCalls === 0
    : consentCalls === expectedConsentCalls && reportCalls === expectedReports;
  result.success =
    result.first.askedPermission &&
    result.first.policyAccuratePermission &&
    result.second.askedPermission === expectedSecondAsked &&
    result.production.reports === expectedReports &&
    trustedToolBehavior &&
    result.first.correctTaskAnswer &&
    result.second.correctTaskAnswer;
  process.stdout.write(
    `${result.runtime} #${result.repetition}: reports=${result.production.reports} companionConsentCalls=${consentCalls} companionReportCalls=${reportCalls} success=${result.success}\n`,
  );
}

const outputPath = resolve(values.output);
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      ranAt: new Date().toISOString(),
      endpoint,
      feedbackMode,
      decision,
      companionInstalled: !values["without-companion"],
      repetitions,
      results,
    },
    null,
    2,
  ),
);
const successes = results.filter((result) => result.success).length;
process.stdout.write(`PASS ${successes}/${results.length}; wrote ${outputPath}\n`);
if (successes !== results.length) process.exitCode = 1;
