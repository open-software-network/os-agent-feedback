import { describe, expect, it } from "vitest";

import { setupAgentPrompt, setupInstructions } from "./instructions";

const origin = "https://app.epode.ai";

describe("static edge setup instructions", () => {
  it("keep the product key server-side and identify the separate upstream origin", () => {
    const instructions = setupInstructions("static-edge", "static", origin);
    const prompt = setupAgentPrompt("static", "static-edge", instructions, origin);

    expect(instructions.install).toContain("agent-feedback-node-0.2.1.tgz");
    expect(instructions.code).toContain("@agent-feedback/node/edge");
    expect(instructions.code).toContain("createStaticDocsProxy");
    expect(instructions.code).toContain('upstreamOrigin: "https://your-docs-origin.example"');
    expect(instructions.code).toContain('include: ["/docs", "/docs/**"]');
    expect(instructions.code).toMatch(/dedicated public docs routes/i);
    expect(instructions.code).not.toContain("af_live_");
    expect(instructions.verify).toMatch(/bodies must be identical/i);
    expect(instructions.verify).toMatch(/404.*405.*without reaching upstream/i);
    expect(prompt).toContain("Use AGENT_FEEDBACK_KEY from the server environment");
    expect(prompt).toContain("Never put the product key in browser JavaScript");
    expect(prompt).toMatch(/dedicated public docs routes.*never a hostname-wide catch-all/i);
    expect(prompt).toMatch(/include as a second fail-closed boundary/i);
  });
});

describe("company setup instructions", () => {
  it.each([
    ["node-express", /customerRef:/, /sessionRef:/],
    ["node-fastify", /customerRef:/, /sessionRef:/],
    ["python-asgi", /customer_ref=/, /session_ref=/],
    ["python-wsgi", /customer_ref=/, /session_ref=/],
    ["go", /CustomerRef:/, /SessionRef:/],
    ["rust", /\.customer_ref\(/, /\.session_ref\(/],
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
    expect(instructions.code).toContain("customerRef");
    expect(instructions.code).toContain("sessionRef");
    expect(prompt).toMatch(/only customer-facing product tools/i);
    expect(prompt).toMatch(/verified product authentication/i);
    expect(prompt).toMatch(/first opportunity, first confirmed interaction, and first report/i);
  });

  it("keeps product keys out of coding-agent prompts and rejects inferred identity guidance", () => {
    const instructions = setupInstructions("node-express", "api", origin);
    const prompt = setupAgentPrompt("api", "node-express", instructions, origin);

    expect(prompt).not.toContain("af_live_");
    expect(prompt).toContain("Never put the product key in browser JavaScript");
    expect(prompt).toMatch(/never a name, email, or caller-supplied unverified value/i);
    expect(prompt).toMatch(/sessionRef only when.*proof/i);
    expect(prompt).toMatch(/unknown, approved, and declined states/i);
  });

  it("pins every downloadable SDK instruction to the advertised 0.2.1 release", () => {
    expect(setupInstructions("node-express", "api", origin).install).toContain(
      "agent-feedback-node-0.2.1.tgz",
    );
    expect(setupInstructions("python-asgi", "api", origin).install).toContain(
      "agent_feedback-0.2.1-py3-none-any.whl",
    );
    expect(setupInstructions("go", "api", origin).install).toContain("sdk/go@v0.2.1");
    expect(setupInstructions("rust", "api", origin).install).toContain(
      "agent-feedback-rust-0.2.1.tar.gz",
    );
  });
});
