#!/usr/bin/env node

import { spawn } from "node:child_process";

const runtimes = [
  {
    id: "codex",
    binary: process.env.CODEX_BIN || "codex",
    versionArgs: ["--version"],
    projectSkillDirectory: ".agents/skills",
    executableHarness: true,
  },
  {
    id: "claude",
    binary: process.env.CLAUDE_BIN || "claude",
    versionArgs: ["--version"],
    projectSkillDirectory: ".claude/skills",
    executableHarness: true,
  },
  {
    id: "amp",
    binary: process.env.AMP_BIN || "amp",
    versionArgs: ["--version"],
    projectSkillDirectory: ".agents/skills",
    compatibleSkillDirectories: [".claude/skills"],
    executableHarness: true,
  },
  {
    id: "gemini",
    binary: process.env.GEMINI_BIN || "gemini",
    versionArgs: ["--version"],
    projectSkillDirectory: ".gemini/skills",
    compatibleSkillDirectories: [".agents/skills"],
    executableHarness: false,
  },
  {
    id: "factory-droid",
    binary: process.env.DROID_BIN || "droid",
    versionArgs: ["--version"],
    projectSkillDirectory: ".factory/skills",
    compatibleSkillDirectories: [".agents/skills", ".agent/skills"],
    executableHarness: true,
  },
  {
    id: "copilot",
    binary: process.env.COPILOT_BIN || "copilot",
    versionArgs: ["--version"],
    projectSkillDirectory: ".agents/skills",
    compatibleSkillDirectories: [".github/skills", ".claude/skills"],
    executableHarness: false,
  },
  {
    id: "opencode",
    binary: process.env.OPENCODE_BIN || "opencode",
    versionArgs: ["--version"],
    projectSkillDirectory: null,
    compatibleSkillDirectories: [".opencode/skills", ".claude/skills", ".agents/skills"],
    executableHarness: false,
  },
];

async function run(binary, args) {
  return await new Promise((resolve) => {
    const child = spawn(binary, args, {
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ installed: false, error: error.message }));
    child.once("close", (code) => resolve({
      installed: code === 0,
      version: stdout.trim() || stderr.trim() || null,
      exitCode: code,
    }));
  });
}

const results = [];
for (const runtime of runtimes) {
  results.push({
    ...runtime,
    ...await run(runtime.binary, runtime.versionArgs),
  });
}

process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), runtimes: results }, null, 2)}\n`);
