import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("dashboard scaffold", () => {
  it("renders the dashboard entry point in the DOM", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { name: "Epode dashboard" })).toBeVisible();
    expect(screen.getByText("The Next.js workspace scaffold is ready.")).toBeInTheDocument();
  });
});
