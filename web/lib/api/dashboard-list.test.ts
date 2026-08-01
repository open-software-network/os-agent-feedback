import { describe, expect, it } from "vitest";

import { feedbackListPath, sessionsListPath } from "./dashboard";

describe("dashboard list request paths", () => {
  it("serializes bounded feedback filters and its opaque cursor", () => {
    const path = feedbackListPath({
      productId: "product-1",
      groupKey: "6910e1b05a001949e02f04db6d67d013",
      q: "checkout timeout",
      status: ["new", "investigating"],
      impact: ["blocked"],
      operation: "checkout",
      customerRef: "tenant-42",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-31T00:00:00.000Z",
      limit: 50,
      cursor: "opaque+/cursor",
    });
    const url = new URL(path, "https://app.epode.ai");

    expect(url.pathname).toBe("/api/dashboard/feedback");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      productId: "product-1",
      groupKey: "6910e1b05a001949e02f04db6d67d013",
      q: "checkout timeout",
      status: "new,investigating",
      impact: "blocked",
      operation: "checkout",
      customerRef: "tenant-42",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-31T00:00:00.000Z",
      limit: "50",
      cursor: "opaque+/cursor",
    });
  });

  it("keeps session search, kind, operation, customer, time, and cursor shareable", () => {
    const path = sessionsListPath({
      productId: "product-1",
      q: "checkout",
      kind: "multi",
      impact: ["blocked", "hindered"],
      operation: "checkout",
      customerRef: "tenant-42",
      since: "2026-07-01T00:00:00.000Z",
      limit: 25,
      cursor: "next-session",
    });
    const url = new URL(path, "https://app.epode.ai");

    expect(url.pathname).toBe("/api/dashboard/sessions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      productId: "product-1",
      q: "checkout",
      kind: "multi",
      impact: "blocked,hindered",
      operation: "checkout",
      customerRef: "tenant-42",
      since: "2026-07-01T00:00:00.000Z",
      limit: "25",
      cursor: "next-session",
    });
  });
});
