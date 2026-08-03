import { describe, expect, it } from "vitest";

import { SETUP_SURFACES, setupAgentPrompt, setupInstructions } from "./instructions";

const origin = "https://app.epode.ai";

describe("company-side customer enrichment setup", () => {
  it("offers the three implemented product surfaces", () => {
    expect(Object.keys(SETUP_SURFACES)).toEqual(["api", "website", "mcp"]);
    expect(SETUP_SURFACES.api.stacks).toEqual(["node-express", "node-fastify"]);
    expect(SETUP_SURFACES.website.stacks).toEqual(["node-express", "node-fastify"]);
    expect(SETUP_SURFACES.mcp.stacks).toEqual(["node-mcp"]);
  });

  it.each([
    ["node-express", "api", "@epode/node/express", 'include: ["/api/recommendations"]'],
    ["node-express", "website", "@epode/node/express", 'include: ["/recommendations"]'],
    ["node-fastify", "api", "@epode/node/fastify", 'include: ["/api/recommendations"]'],
    ["node-fastify", "website", "@epode/node/fastify", 'include: ["/recommendations"]'],
  ] as const)("configures %s for %s with the released SDK", (stack, surface, sdkImport, include) => {
    const instructions = setupInstructions(stack, surface, origin);

    expect(instructions.install).toContain("@epode/node@0.4");
    expect(instructions.code).toContain(`from "${sdkImport}"`);
    expect(instructions.code).toContain("apiKey: process.env.EPODE_API_KEY");
    expect(instructions.code).toContain(include);
    expect(instructions.code).toContain('purpose: "product_personalization"');
    expect(instructions.code).toContain("accountRef:");
    expect(instructions.code).toContain("userRef:");
    expect(instructions.code).toContain("anonymousRef:");
    expect(instructions.code).not.toContain("AGENT_FEEDBACK_KEY");
    expect(instructions.code).not.toContain("af_live_");
  });

  it("runs verified product authentication before HTTP enrichment", () => {
    expect(setupInstructions("node-express", "api", origin).code).toMatch(
      /app\.use\(productAuthentication\)[\s\S]*const customer = epode/,
    );
    expect(setupInstructions("node-fastify", "api", origin).code).toMatch(
      /addHook\("preHandler", productAuthentication\)[\s\S]*const customer = epode/,
    );
  });

  it("instruments selected MCP tools with authenticated or first-party references", () => {
    const instructions = setupInstructions("node-mcp", "mcp", origin);

    expect(instructions.install).toContain("@epode/node@0.4");
    expect(instructions.code).toContain('from "@epode/node/mcp"');
    expect(instructions.code).toContain('includeTools: ["search_products"]');
    expect(instructions.code).toContain('purpose: "product_personalization"');
    expect(instructions.code).toContain("context.http?.authInfo?.extra?.accountId");
    expect(instructions.code).toContain("customer.instrument(server)");
    expect(instructions.verify).toMatch(/real MCP client/i);
  });

  it("gives coding agents an exact, privacy-bounded implementation contract", () => {
    const instructions = setupInstructions("node-express", "api", origin);
    const prompt = setupAgentPrompt("api", "node-express", instructions, origin);

    expect(prompt).toContain("Use EPODE_API_KEY only from the server environment");
    expect(prompt).toContain(`Install exactly: ${instructions.install}`);
    expect(prompt).toMatch(/authentication before Epode/i);
    expect(prompt).toMatch(/product-owned first-party visitor ID/i);
    expect(prompt).toMatch(/do not invent customer identity, permission, answers/i);
    expect(prompt).not.toContain("AGENT_FEEDBACK_KEY");
    expect(prompt).not.toContain("af_live_");
    expect(prompt).not.toContain("agent-feedback-node");
  });
});
