import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SignInPage from "./page";

describe("SignInPage", () => {
  it("forwards a validated dashboard deep link to auth start", async () => {
    const returnTo = "/?view=feedback&report=report-1";
    render(await SignInPage({ searchParams: Promise.resolve({ return_to: returnTo }) }));
    expect(screen.getByRole("link", { name: "Continue with OS Accounts" })).toHaveAttribute(
      "href",
      `/auth/start?return_to=${encodeURIComponent(returnTo)}`,
    );
  });

  it("drops an external return target", async () => {
    render(
      await SignInPage({
        searchParams: Promise.resolve({ return_to: "https://evil.example/steal" }),
      }),
    );
    expect(screen.getByRole("link", { name: "Continue with OS Accounts" })).toHaveAttribute(
      "href",
      "/auth/start",
    );
  });
});
