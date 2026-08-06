import { describe, expect, it } from "vitest";

import { acoReportLoaders } from "@/aco-reports/registry";

import {
  accessToken,
  passwordMatches,
  reportAsset,
  reportPassword,
  tokenMatches,
  validReportSlug,
} from "./reports";

describe("reportPassword", () => {
  const environment = {
    ACO_REPORT_PASSWORDS: "petsmart:sword-fish, acme:open-sesame ,broken,empty:",
  };

  it("resolves configured slugs", () => {
    expect(reportPassword("petsmart", environment)).toBe("sword-fish");
    expect(reportPassword("acme", environment)).toBe("open-sesame");
  });

  it("fails closed for unknown, malformed, or empty entries", () => {
    expect(reportPassword("unknown", environment)).toBeUndefined();
    expect(reportPassword("broken", environment)).toBeUndefined();
    expect(reportPassword("empty", environment)).toBeUndefined();
    expect(reportPassword("petsmart", {})).toBeUndefined();
  });

  it("rejects invalid slugs before consulting configuration", () => {
    expect(validReportSlug("../etc")).toBe(false);
    expect(validReportSlug("PetSmart")).toBe(false);
    expect(reportPassword("../petsmart", environment)).toBeUndefined();
  });
});

describe("access tokens", () => {
  it("round-trips for the matching slug and password", () => {
    const token = accessToken("petsmart", "sword-fish");
    expect(tokenMatches(token, "petsmart", "sword-fish")).toBe(true);
  });

  it("rejects other slugs, passwords, and forged values", () => {
    const token = accessToken("petsmart", "sword-fish");
    expect(tokenMatches(token, "acme", "sword-fish")).toBe(false);
    expect(tokenMatches(token, "petsmart", "rotated")).toBe(false);
    expect(tokenMatches("forged", "petsmart", "sword-fish")).toBe(false);
  });

  it("compares passwords in constant time without throwing on length skew", () => {
    expect(passwordMatches("short", "much-longer-password")).toBe(false);
    expect(passwordMatches("same", "same")).toBe(true);
  });
});

describe("report registry", () => {
  it("loads the committed petsmart report component", async () => {
    const loader = acoReportLoaders.petsmart;
    expect(loader).toBeDefined();
    const module = await loader();
    expect(module.default).toBeTypeOf("function");
  });
});

describe("report assets", () => {
  it("loads committed report assets", async () => {
    const asset = await reportAsset("petsmart", "1-agent-guide.png");
    expect(asset?.subarray(1, 4).toString()).toBe("PNG");
  });

  it("refuses traversal and unknown files", async () => {
    expect(await reportAsset("petsmart", "../report.html")).toBeUndefined();
    expect(await reportAsset("petsmart", "report.html")).toBeUndefined();
    expect(await reportAsset("petsmart", "nope.png")).toBeUndefined();
  });
});
