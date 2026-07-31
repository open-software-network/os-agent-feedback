#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { analyzeOpenApi, compileApprovedIr } from "./openapi-company-review.mjs";

function usage() {
  return [
    "Usage:",
    "  node openapi-company-review-cli.mjs <openapi.json>",
    "  node openapi-company-review-cli.mjs <openapi.json> --approval <approval.json>",
    "",
    "The command reads local files and writes JSON to stdout.",
    "It performs no network or deployment action.",
  ].join("\n");
}

const arguments_ = process.argv.slice(2);
if (arguments_.length === 0 || arguments_.includes("--help")) {
  process.stdout.write(`${usage()}\n`);
  process.exit(arguments_.includes("--help") ? 0 : 2);
}

const specPath = arguments_[0];
const approvalFlag = arguments_.indexOf("--approval");
if (approvalFlag !== -1 && !arguments_[approvalFlag + 1]) {
  throw new Error("--approval requires a local JSON file path");
}
const bytes = await readFile(specPath);
const options = { sourceName: basename(specPath) };
const output =
  approvalFlag === -1
    ? analyzeOpenApi(bytes, options)
    : compileApprovedIr(
        bytes,
        JSON.parse(await readFile(arguments_[approvalFlag + 1], "utf8")),
        options,
      );
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
