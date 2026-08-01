import { describe, expect, it } from "vitest";

import { setupAgentPrompt, setupInstructions } from "./instructions";

const origin = "https://app.epode.ai";

describe("static edge setup instructions", () => {
  it("keep the product key server-side and identify the separate upstream origin", () => {
    const instructions = setupInstructions("static-edge", "static", origin);
    const prompt = setupAgentPrompt("static", "static-edge", instructions, origin);

    expect(instructions.install).toContain("agent-feedback-node-0.3.0.tgz");
    expect(instructions.code).toContain("@agent-feedback/node/edge");
    expect(instructions.code).toContain("createStaticDocsProxy");
    expect(instructions.code).toContain('upstreamOrigin: "https://your-docs-origin.example"');
    expect(instructions.code).toContain('include: ["/docs", "/docs/**"]');
    expect(instructions.code).toContain("feedbackMode: env.AGENT_FEEDBACK_MODE");
    expect(instructions.code).toMatch(/dedicated public docs routes/i);
    expect(instructions.code).not.toContain("af_live_");
    expect(instructions.verify).toMatch(/bodies must be identical/i);
    expect(instructions.verify).toMatch(/404.*405.*without reaching upstream/i);
    expect(prompt).toContain("Use AGENT_FEEDBACK_KEY from the server environment");
    expect(prompt).toContain("Never put the product key in browser JavaScript");
    expect(prompt).toMatch(/dedicated public docs routes.*never a hostname-wide catch-all/i);
    expect(prompt).toMatch(/include as a second fail-closed boundary/i);
    expect(prompt).toMatch(/verify the public proxy without product authentication/i);
    expect(prompt).not.toMatch(/integration doctor/i);
  });
});

describe("company setup instructions", () => {
  it.each([
    ["node-express", /accountRef:/, /sessionRef:/],
    ["node-fastify", /accountRef:/, /sessionRef:/],
    ["python-asgi", /account_ref=/, /session_ref=/],
    ["python-wsgi", /account_ref=/, /session_ref=/],
    ["go", /AccountRef:/, /SessionRef:/],
    ["rust", /\.account_ref\(/, /\.session_ref\(/],
  ] as const)("%s includes authenticated customer grouping and optional proven session grouping", (stack, customerRef, sessionRef) => {
    const instructions = setupInstructions(stack, "api", origin);

    expect(instructions.code).toMatch(customerRef);
    expect(instructions.code).toMatch(sessionRef);
    expect(instructions.code).toMatch(/replace with customer-agent product routes/i);
    expect(instructions.code).not.toContain("af_live_");
  });

  it("makes MCP tool selection and authenticated identity explicit", () => {
    const instructions = setupInstructions("node-mcp", "mcp", origin);
    const prompt = setupAgentPrompt("mcp", "node-mcp", instructions, origin);

    expect(instructions.code).toContain("includeTools");
    expect(instructions.code).toContain("accountRef");
    expect(instructions.code).toContain("userRef");
    expect(instructions.code).toContain("anonymousRef");
    expect(instructions.code).toContain("sessionRef");
    expect(instructions.code).toContain("new McpServer");
    expect(instructions.code).toContain("instructions:");
    expect(instructions.code).toContain("consent_required");
    expect(instructions.code).toContain("feedback_ready");
    expect(instructions.code).toContain("feedback_disabled");
    expect(instructions.install).toContain("@modelcontextprotocol/express zod");
    expect(instructions.code).toContain("requireBearerAuth");
    expect(instructions.code).toContain("productTokenVerifier");
    expect(instructions.code).toContain("record_product_feedback_consent");
    expect(instructions.code).toContain("report_product_feedback");
    expect(instructions.code).toMatch(
      /app\.use\("\/mcp", requireBearerAuth[\s\S]*app\.all\("\/mcp"/,
    );
    expect(instructions.code).toMatch(/typeof accountId === "string"/);
    expect(prompt).toMatch(/only customer-facing product tools/i);
    expect(prompt).toMatch(/product authentication.*verified identity/i);
    expect(prompt).toMatch(/real MCP 2026-07-28 client, not an HTTP GET doctor/i);
    expect(prompt).not.toMatch(/integration doctor/i);
    expect(prompt).toMatch(/never approve or decline feedback permission/i);
    expect(prompt).toMatch(/customer-agent activation task for a real tester/i);
  });

  it("orders verified product authentication before adapters that depend on request identity", () => {
    expect(setupInstructions("node-express", "api", origin).code).toMatch(
      /productAuthentication[\s\S]*agentFeedback/,
    );
    expect(setupInstructions("node-fastify", "api", origin).code).toMatch(
      /addHook\("preHandler", productAuthentication\)[\s\S]*agentFeedback/,
    );
    expect(setupInstructions("go", "api", origin).code).toContain(
      "productAuthentication(feedback.Middleware(router))",
    );
    expect(setupInstructions("rust", "api", origin).code).toContain(
      ".layer(feedback.clone()).layer(product_auth_layer())",
    );
  });

  it("keeps product keys out of coding-agent prompts and rejects inferred identity guidance", () => {
    const instructions = setupInstructions("node-express", "api", origin);
    const prompt = setupAgentPrompt("api", "node-express", instructions, origin);

    expect(prompt).not.toContain("af_live_");
    expect(prompt).toContain("Never put the product key in browser JavaScript");
    expect(prompt).toMatch(/never a name, email, or caller-supplied unverified value/i);
    expect(prompt).toMatch(/sessionRef only when.*proof/i);
    expect(prompt).toMatch(/real tester's explicit decision/i);
  });

  it("pins every downloadable SDK instruction to the advertised 0.3.0 release", () => {
    expect(setupInstructions("node-express", "api", origin).install).toContain(
      "agent-feedback-node-0.3.0.tgz",
    );
    expect(setupInstructions("python-asgi", "api", origin).install).toContain(
      "agent_feedback-0.3.0-py3-none-any.whl",
    );
    expect(setupInstructions("go", "api", origin).install).toContain(
      "agent-feedback-go-0.3.0.tar.gz",
    );
    expect(setupInstructions("rust", "api", origin).install).toContain(
      "agent-feedback-rust-0.3.0.tar.gz",
    );
  });

  it("keeps hosted Node packages in a stable project-local cache", () => {
    for (const [stack, surface] of [
      ["node-express", "api"],
      ["node-mcp", "mcp"],
      ["static-edge", "static"],
    ] as const) {
      const install = setupInstructions(stack, surface, origin).install;
      expect(install).toContain("mkdir -p .epode/artifacts");
      expect(install).toContain('epode_artifact=".epode/artifacts/agent-feedback-node-0.3.0.tgz"');
      expect(install).toContain('npm install "$epode_artifact"');
      expect(install).not.toContain("mktemp");
    }
  });

  it("never continues into installation after a failed artifact checksum", () => {
    for (const [stack, surface] of [
      ["node-express", "api"],
      ["node-mcp", "mcp"],
      ["python-asgi", "api"],
      ["python-wsgi", "api"],
      ["go", "api"],
      ["rust", "api"],
      ["manual-http", "api"],
      ["manual-mcp", "mcp"],
      ["static-edge", "static"],
    ] as const) {
      const install = setupInstructions(stack, surface, origin).install;
      expect(install, stack).toMatch(/curl[^\n]*&&\n/);
      const [, afterChecksum = ""] = install.split("shasum -a 256 -c -", 2);
      if (afterChecksum.trim().length > 0) {
        expect(afterChecksum, stack).toMatch(/^\s*&&\n/);
      }
    }
  });
});
