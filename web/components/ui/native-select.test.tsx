import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NativeSelect } from "./native-select";

describe("NativeSelect", () => {
  it("uses the compact Central dual chevron", () => {
    const { container } = render(
      <NativeSelect aria-label="Role">
        <option>Member</option>
      </NativeSelect>,
    );

    expect(screen.getByRole("combobox", { name: "Role" })).toBeVisible();
    const icon = container.querySelector('[data-slot="native-select-icon"]');
    expect(icon).toHaveAttribute("width", "14px");
    expect(icon).toHaveAttribute("height", "14px");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
