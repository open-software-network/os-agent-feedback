#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { positionals } = parseArgs({ allowPositionals: true });
if (!positionals.length) throw new Error("Usage: node analyze.mjs RESULTS.json [...RESULTS.json]");

const documents = await Promise.all(positionals.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const results = documents.flatMap((document) => document.results);
const groups = new Map();
for (const result of results) {
  const key = [
    `${result.runtime}:${result.model || "default"}`,
    result.scenario.mode,
    result.scenario.placement + (result.scenario.projectDiscoversLlms ? "+project_discovery" : ""),
    result.scenario.copy,
  ].join("|");
  const group = groups.get(key) || [];
  group.push(result);
  groups.set(key, group);
}

function percentage(numerator, denominator) {
  return denominator ? `${Math.round((100 * numerator) / denominator)}%` : "—";
}

console.log("| Runtime | Mode | Placement | Copy | n | Discovered | Asked | Attempted | First valid | Repaired | Accepted | Task correct | Main result |");
console.log("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
for (const [key, group] of groups) {
  const [runtime, mode, placement, copy] = key.split("|");
  const count = (field) => group.filter((result) => result.observations[field]).length;
  const failures = Object.entries(group.reduce((all, result) => {
    const failure = result.observations.failureClass;
    all[failure] = (all[failure] || 0) + 1;
    return all;
  }, {})).sort((a, b) => b[1] - a[1]);
  console.log(`| ${runtime} | ${mode} | ${placement} | ${copy} | ${group.length} | ${percentage(count("llmsFetched"), group.length)} | ${percentage(group.filter((result) => result.agent.askedPermission).length, group.length)} | ${percentage(count("submissionAttempted"), group.length)} | ${percentage(count("firstAttemptAccepted"), group.length)} | ${percentage(count("recoveredAfterRejection"), group.length)} | ${percentage(count("submissionAccepted"), group.length)} | ${percentage(count("correctTaskAnswer"), group.length)} | ${failures[0]?.[0] || "—"} |`);
}

const sequences = results.filter((result) => result.scenario.sequence);
if (sequences.length) {
  console.log("\n| Runtime | Mode | Placement | n | First asked | First accepted | Second asked | Second accepted | Stored grant | Sequence result |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---|");
  const sequenceGroups = new Map();
  for (const result of sequences) {
    const key = [`${result.runtime}:${result.model || "default"}`, result.scenario.mode, result.scenario.placement].join("|");
    sequenceGroups.set(key, [...(sequenceGroups.get(key) || []), result]);
  }
  for (const [key, group] of sequenceGroups) {
    const [runtime, mode, placement] = key.split("|");
    const count = (predicate) => group.filter(predicate).length;
    const classes = Object.entries(group.reduce((all, result) => {
      const value = result.observations.sequenceClass;
      all[value] = (all[value] || 0) + 1;
      return all;
    }, {})).sort((a, b) => b[1] - a[1]);
    console.log(`| ${runtime} | ${mode} | ${placement} | ${group.length} | ${percentage(count((result) => result.agent.askedPermission), group.length)} | ${percentage(count((result) => result.observations.submissionAccepted), group.length)} | ${percentage(count((result) => result.observations.secondAskedPermission), group.length)} | ${percentage(count((result) => result.observations.secondSubmissionAccepted), group.length)} | ${percentage(count((result) => result.observations.secondUsedStoredGrant), group.length)} | ${classes[0]?.[0] || "—"} |`);
  }
}
