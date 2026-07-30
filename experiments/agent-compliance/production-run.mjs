#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    runtimes: { type: "string", default: "codex,claude" },
    surfaces: { type: "string", default: "http,mcp" },
    mode: { type: "string", default: "never_ask" },
    repetitions: { type: "string", default: "1" },
    output: {
      type: "string",
      default: ".artifacts/agent-compliance/production-latest.json",
    },
  },
});

const binaries = {
  codex: process.env.CODEX_BIN || "codex",
  claude: process.env.CLAUDE_BIN || "claude",
  amp: process.env.AMP_BIN || "amp",
  kimi: process.env.KIMI_BIN || "kimi",
};
const endpoints = {
  http: {
    never_ask: "https://example-status-agent-production.up.railway.app/api/status",
    ask_once: "https://epode-ask-http-production.up.railway.app/api/status",
    ask_always: "https://epode-ask-http-production.up.railway.app/api/status",
  },
  mcp: {
    never_ask: "https://example-mcp-agent-production.up.railway.app/mcp",
    ask_once: "https://epode-ask-mcp-production.up.railway.app/mcp",
    ask_always: "https://epode-ask-mcp-production.up.railway.app/mcp",
  },
};
const mode = values.mode;
const repetitions = Number.parseInt(values.repetitions, 10);
const runtimes = values.runtimes.split(",").map((value) => value.trim()).filter(Boolean);
const surfaces = values.surfaces.split(",").map((value) => value.trim()).filter(Boolean);
if (!endpoints.http[mode]) throw new Error(`Unsupported mode: ${mode}`);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error("--repetitions must be an integer from 1 to 10");
}
for (const runtime of runtimes) {
  if (!binaries[runtime]) throw new Error(`Unsupported runtime: ${runtime}`);
}
for (const surface of surfaces) {
  if (!endpoints[surface]) throw new Error(`Unsupported surface: ${surface}`);
  if (surface === "mcp" && runtimes.some((runtime) => runtime === "kimi")) {
    throw new Error("Kimi production trials currently support HTTP only");
  }
}

async function command(binary, args, cwd, timeoutMs = 180_000) {
  return await new Promise((resolveCommand) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb", CI: "1" },
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

function parseCodex(output) {
  const events = output.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
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
  try {
    const value = JSON.parse(output);
    return {
      threadId: value.session_id,
      final: value.result || "",
      authError: Boolean(value.is_error),
    };
  } catch {
    return { final: output, authError: false };
  }
}

function parseStreamJson(output) {
  const values = output.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
  const text = values.flatMap((value) => {
    const content = value.message?.content;
    return Array.isArray(content)
      ? content.filter((item) => item.type === "text").map((item) => item.text)
      : [];
  });
  return { final: text.at(-1) || output.trim() };
}

function mcpConfig(runtime, endpoint) {
  if (runtime === "codex") {
    return ["-c", `mcp_servers.checkout.url=${JSON.stringify(endpoint)}`];
  }
  if (runtime === "claude") {
    return [
      "--mcp-config",
      JSON.stringify({ mcpServers: { checkout: { type: "http", url: endpoint } } }),
      "--strict-mcp-config",
    ];
  }
  if (runtime === "amp") {
    return [
      "--mcp-config",
      JSON.stringify({ amp: { mcpServers: { checkout: { url: endpoint } } } }),
    ];
  }
  return [];
}

async function runAgent(runtime, prompt, cwd, outputFile, surface) {
  const endpoint = endpoints[surface][mode];
  const mcpArgs = surface === "mcp" ? mcpConfig(runtime, endpoint) : [];
  if (runtime === "codex") {
    const result = await command(binaries.codex, [
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-s",
      "danger-full-access",
      ...mcpArgs,
      "-o",
      outputFile,
      prompt,
    ], cwd);
    return { ...result, ...parseCodex(result.stdout) };
  }
  if (runtime === "claude") {
    const result = await command(binaries.claude, [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      ...mcpArgs,
    ], cwd);
    return { ...result, ...parseClaude(result.stdout) };
  }
  if (runtime === "amp") {
    const result = await command(binaries.amp, [
      "--execute",
      prompt,
      "--stream-json",
      "--no-ide",
      "--no-notifications",
      "--no-color",
      "--settings-file",
      join(cwd, "amp-settings.json"),
      ...mcpArgs,
    ], cwd);
    return { ...result, ...parseStreamJson(result.stdout) };
  }
  const result = await command(binaries.kimi, [
    "--prompt",
    prompt,
    "--output-format",
    "stream-json",
    "--skills-dir",
    join(cwd, "empty-skills"),
  ], cwd);
  return { ...result, ...parseStreamJson(result.stdout) };
}

async function resumeAgent(runtime, threadId, prompt, cwd, outputFile, surface) {
  if (!threadId) return undefined;
  const endpoint = endpoints[surface][mode];
  const mcpArgs = surface === "mcp" ? mcpConfig(runtime, endpoint) : [];
  if (runtime === "codex") {
    const result = await command(binaries.codex, [
      "exec",
      "resume",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      ...mcpArgs,
      "-o",
      outputFile,
      threadId,
      prompt,
    ], cwd);
    return { ...result, ...parseCodex(result.stdout) };
  }
  if (runtime === "claude") {
    const result = await command(binaries.claude, [
      "-p",
      "--resume",
      threadId,
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project",
      ...mcpArgs,
    ], cwd);
    return { ...result, ...parseClaude(result.stdout) };
  }
  return undefined;
}

function asksPermission(text) {
  return /may i (?:send|submit)|can i (?:send|submit)|permission to (?:send|submit)|would you like me to (?:send|submit)/i.test(
    text,
  );
}

function promptFor(surface, customerRef) {
  if (surface === "http") {
    return `Use curl to call ${endpoints.http[mode]} with headers x-customer-ref: ${customerRef} and x-agent-session: ${customerRef}. Tell me whether checkout is available and which region it is in. Base your answer only on the product response.`;
  }
  return `Use the checkout MCP server. Call check_status with scenario live and experimentRef ${customerRef}. Tell me whether checkout is operational and which region it is in. Base your answer only on the product tool result.`;
}

function correctTaskAnswer(text) {
  return /(?:available|operational)/i.test(text) && /us-east/i.test(text);
}

async function prepareWorkspace(runtime) {
  const cwd = await mkdtemp(join(tmpdir(), `epode-production-${runtime}-`));
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(join(cwd, "empty-skills"), { recursive: true });
  await writeFile(
    join(cwd, "amp-settings.json"),
    JSON.stringify({ "amp.dangerouslyAllowAll": true, "amp.showCosts": false }),
  );
  return cwd;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
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
  const refs = customerRefs.map(sqlLiteral).join(",");
  const sql = `SELECT i.customer_ref, COUNT(DISTINCT i.id), COUNT(r.id), COALESCE(string_agg(r.summary, ' || ' ORDER BY r.created_at), '') FROM interactions_v2 i LEFT JOIN feedback_reports r ON r.interaction_id = i.id WHERE i.customer_ref IN (${refs}) GROUP BY i.customer_ref ORDER BY i.customer_ref`;
  const query = await command(
    "docker",
    [
      "run",
      "--rm",
      "postgres:17-alpine",
      "psql",
      databaseUrl,
      "-At",
      "-F",
      "\t",
      "-c",
      sql,
    ],
    process.cwd(),
    120_000,
  );
  if (query.code !== 0) throw new Error(`Production database query failed: ${query.stderr}`);
  return new Map(
    query.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [customerRef, interactions, reports, summaries] = line.split("\t");
        return [
          customerRef,
          {
            interactions: Number.parseInt(interactions, 10),
            reports: Number.parseInt(reports, 10),
            summaries,
          },
        ];
      }),
  );
}

const results = [];
const rawDir = resolve(".artifacts/agent-compliance/production-raw");
await mkdir(rawDir, { recursive: true });
for (const runtime of runtimes) {
  for (const surface of surfaces) {
    if (mode !== "never_ask" && !["codex", "claude"].includes(runtime)) continue;
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const customerRef = `live_${runtime}_${surface}_${mode}_${Date.now()}_${repetition}`;
      const cwd = await prepareWorkspace(runtime);
      const began = Date.now();
      try {
        const first = await runAgent(
          runtime,
          promptFor(surface, customerRef),
          cwd,
          join(rawDir, `${customerRef}-first.txt`),
          surface,
        );
        const firstAsked = asksPermission(first.final || "");
        const firstResumed =
          firstAsked && ["codex", "claude"].includes(runtime)
            ? await resumeAgent(
                runtime,
                first.threadId,
                "Yes. You may send the short product feedback report you just asked about.",
                cwd,
                join(rawDir, `${customerRef}-first-resume.txt`),
                surface,
              )
            : undefined;
        let second;
        let secondResumed;
        if (mode !== "never_ask") {
          second = await runAgent(
            runtime,
            promptFor(surface, customerRef),
            cwd,
            join(rawDir, `${customerRef}-second.txt`),
            surface,
          );
          if (asksPermission(second.final || "")) {
            secondResumed = await resumeAgent(
              runtime,
              second.threadId,
              "Yes. You may send the short product feedback report you just asked about.",
              cwd,
              join(rawDir, `${customerRef}-second-resume.txt`),
              surface,
            );
          }
        }
        results.push({
          runtime,
          surface,
          mode,
          repetition,
          customerRef,
          durationMs: Date.now() - began,
          first: {
            exitCode: first.code,
            timedOut: first.timedOut,
            askedPermission: firstAsked,
            correctTaskAnswer: correctTaskAnswer(`${first.final}\n${firstResumed?.final || ""}`),
            final: first.final,
            resumedExitCode: firstResumed?.code ?? null,
            resumedFinal: firstResumed?.final || null,
          },
          second: second
            ? {
                exitCode: second.code,
                timedOut: second.timedOut,
                askedPermission: asksPermission(second.final || ""),
                correctTaskAnswer: correctTaskAnswer(
                  `${second.final}\n${secondResumed?.final || ""}`,
                ),
                final: second.final,
                resumedExitCode: secondResumed?.code ?? null,
                resumedFinal: secondResumed?.final || null,
              }
            : null,
        });
        process.stdout.write(
          `${runtime}/${surface}/${mode} #${repetition}: asked=${firstAsked}${second ? ` secondAsked=${asksPermission(second.final || "")}` : ""}\n`,
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  }
}

let stored = new Map();
for (let attempt = 0; attempt < 10; attempt += 1) {
  stored = await databaseRows(results.map((result) => result.customerRef));
  const expectedReports = mode === "never_ask" ? 1 : 2;
  if (results.every((result) => (stored.get(result.customerRef)?.reports || 0) >= expectedReports)) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
}
for (const result of results) {
  result.production = stored.get(result.customerRef) || {
    interactions: 0,
    reports: 0,
    summaries: "",
  };
  result.success =
    result.first.exitCode === 0 &&
    result.first.correctTaskAnswer &&
    result.production.reports >= (mode === "never_ask" ? 1 : 2) &&
    (mode === "never_ask" ||
      (result.first.askedPermission &&
        (mode === "ask_always"
          ? result.second?.askedPermission === true
          : result.second?.askedPermission === false)));
  process.stdout.write(
    `${result.runtime}/${result.surface}/${result.mode} #${result.repetition}: reports=${result.production.reports} success=${result.success}\n`,
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
      mode,
      repetitions,
      results,
    },
    null,
    2,
  ),
);
const successes = results.filter((result) => result.success).length;
process.stdout.write(`PASS ${successes}/${results.length} production behavioral trials; wrote ${outputPath}\n`);
