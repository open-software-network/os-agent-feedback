import { describe, expect, it } from "vitest";

import { customersPath, featuresPath, signalsPath } from "./customer-intelligence";

describe("customer intelligence API paths", () => {
  it("serializes customer filters and cursor without exposing identity values", () => {
    const path = customersPath({
      productId: "product-1",
      q: "enterprise",
      identityLevel: ["verified", "pseudonymous"],
      outcomeHealth: ["blocked"],
      signalType: ["intent", "friction"],
      consentState: ["approved"],
      segment: ["enterprise"],
      since: "2026-07-01T00:00:00Z",
      limit: 50,
      cursor: "opaque-cursor",
    });
    const url = new URL(path, "https://app.epode.ai");
    expect(url.pathname).toBe("/api/dashboard/customers");
    expect(url.searchParams.get("identityLevel")).toBe("verified,pseudonymous");
    expect(url.searchParams.get("signalType")).toBe("intent,friction");
    expect(url.searchParams.get("cursor")).toBe("opaque-cursor");
  });

  it("serializes feature and signal evidence filters independently", () => {
    const feature = new URL(
      featuresPath({
        productId: "product-1",
        signalType: ["feature_need"],
        impact: ["blocked"],
        status: ["new"],
        segment: ["enterprise"],
      }),
      "https://app.epode.ai",
    );
    expect(feature.pathname).toBe("/api/dashboard/features");
    expect(feature.searchParams.get("signalType")).toBe("feature_need");

    const signals = new URL(
      signalsPath({
        productId: "product-1",
        customerId: "customer-1",
        featureKey: "freshness-gap",
        sessionId: "session-1",
        type: ["intent", "outcome"],
        provenance: ["agent_reports_current_task"],
      }),
      "https://app.epode.ai",
    );
    expect(signals.pathname).toBe("/api/dashboard/signals");
    expect(signals.searchParams.get("customerId")).toBe("customer-1");
    expect(signals.searchParams.get("featureKey")).toBe("freshness-gap");
    expect(signals.searchParams.get("type")).toBe("intent,outcome");
  });
});
