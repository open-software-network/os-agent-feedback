import { describe, expect, it } from "vitest";

import { setupAgentPrompt, setupInstructions } from "./instructions";

describe("static edge setup instructions", () => {
  it("keep the product key server-side and identify the separate upstream origin", () => {
    const origin = "https://app.epode.ai";
    const instructions = setupInstructions("static-edge", "static", origin);
    const prompt = setupAgentPrompt("static", "static-edge", instructions, origin);

    expect(instructions.install).toContain("agent-feedback-node-0.2.0.tgz");
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
