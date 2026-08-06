import { describe, expect, it } from "vitest";

import { SETUP_SURFACES, setupAgentPrompt, setupInstructions } from "./instructions";

const origin = "https://app.epode.ai";

describe("company-side customer enrichment setup", () => {
  it("configures the agent experience graph surface with journey telemetry", () => {
    const instructions = setupInstructions("node-experience", "experience", origin);
    expect(instructions.install).toContain("@epode/node@0.4");
    expect(instructions.code).toContain("@epode/node/experience-graph");
    expect(instructions.code).toContain("createExperienceGraph");
    expect(instructions.code).toContain("experienceTelemetryDetails");
    expect(instructions.code).toContain("/agent-negotiate");
    expect(instructions.code).toContain("/agent-decide");
    expect(instructions.verify).toMatch(/session telemetry/i);
  });

  it("offers the four implemented product surfaces", () => {
    expect(Object.keys(SETUP_SURFACES)).toEqual(["experience", "api", "website", "mcp"]);
    expect(SETUP_SURFACES.experience.stacks).toEqual(["node-experience"]);
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
    expect(instructions.code).toContain("sessionRef:");
    expect(instructions.code).toContain("canonicalId");
    expect(instructions.code).toMatch(/\}\),\n {2}sessionRef: (?:req|request) =>/);
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
    expect(instructions.code).toContain("new WeakMap<object, string>()");
    expect(instructions.code).toContain("identify: (args, context, result)");
    expect(instructions.code).toContain("customers.fromAuthInfo(context.http?.authInfo)");
    expect(instructions.code).toContain("workflowCandidate(args, result)");
    expect(instructions.code).toContain("workflows.findOwned(authenticatedCustomer, candidate)");
    expect(instructions.code).toContain(
      "ownedWorkflowByInvocation.set(context, ownedWorkflow.canonicalId)",
    );
    expect(instructions.code).toContain(
      "sessionRef: context => ownedWorkflowByInvocation.get(context)",
    );
    expect(instructions.code).toContain("customer.instrument(server)");
    expect(instructions.verify).toMatch(/real MCP client/i);
  });

  it("gives coding agents an experience-graph implementation contract", () => {
    const instructions = setupInstructions("node-experience", "experience", origin);
    const prompt = setupAgentPrompt("experience", "node-experience", instructions, origin);
    expect(prompt).toContain("guided agent experience");
    expect(prompt).toContain("experienceTelemetryDetails");
    expect(prompt).toContain("/agent-negotiate");
    expect(prompt).toMatch(/current-task decision input/i);
    expect(prompt).not.toContain("AGENT_FEEDBACK_KEY");
    expect(prompt).not.toContain("af_live_");
  });

  it("gives coding agents an exact, privacy-bounded implementation contract", () => {
    const instructions = setupInstructions("node-express", "api", origin);
    const prompt = setupAgentPrompt("api", "node-express", instructions, origin);

    expect(prompt).toContain("Use EPODE_API_KEY only from the server environment");
    expect(prompt).toContain(`Install exactly: ${instructions.install}`);
    expect(prompt).toMatch(/authentication before Epode/i);
    expect(prompt).toMatch(/product-owned first-party visitor ID/i);
    expect(prompt).toMatch(/do not invent customer identity, permission, answers/i);
    expect(prompt).toMatch(/stable typed Customer identity/i);
    expect(prompt).toMatch(/canonical ID returned by workflow creation/i);
    expect(prompt).toMatch(/request or trace IDs/i);
    expect(prompt).toMatch(/Run A[\s\S]*Session A[\s\S]*Run B[\s\S]*Session B/i);
    expect(prompt).toMatch(/missing and invalid ownership proof[\s\S]*unlinked/i);
    expect(prompt).toMatch(/Epode outage/i);
    expect(prompt).toMatch(/arguments, prompts, results, credentials, or exceptions/i);
    expect(prompt).not.toContain("AGENT_FEEDBACK_KEY");
    expect(prompt).not.toContain("af_live_");
    expect(prompt).not.toContain("agent-feedback-node");
  });
});
