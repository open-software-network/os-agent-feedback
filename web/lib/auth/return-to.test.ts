import { describe, expect, it } from "vitest";

import { authStartPath, currentReturnTo, safeReturnTo } from "@/lib/auth/return-to";

describe("authentication return paths", () => {
  it("preserves report and session deep links as same-origin relative paths", () => {
    const report = "/?view=feedback&team=team-1&report=report-1";
    const session = "/?view=sessions&team=team-1&session=session-1#timeline";
    expect(safeReturnTo(report)).toBe(report);
    expect(authStartPath(session)).toBe(`/auth/start?return_to=${encodeURIComponent(session)}`);
    expect(
      currentReturnTo({
        pathname: "/",
        search: "?view=feedback&report=report-1",
        hash: "#finding",
      }),
    ).toBe("/?view=feedback&report=report-1#finding");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "dashboard?view=feedback",
    "/dashboard\nset-cookie: injected",
    "",
  ])("rejects unsafe return path %j", (value) => {
    expect(safeReturnTo(value)).toBeNull();
    expect(authStartPath(value)).toBe("/auth/start");
  });
});
