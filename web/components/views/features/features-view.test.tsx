import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dashboardFixture,
  featureDetailFixture,
  featuresPageFixture,
} from "@/components/dashboard/test-fixture";
import { FeaturesView } from "./features-view";

describe("FeaturesView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/?view=features");
  });

  it("ranks needs by complete affected-customer and evidence counts", async () => {
    const fetchMock = mockFeatures();
    renderFeatures(fetchMock);

    const row = await screen.findByRole("row", {
      name: "Open feature Fresh results after indexing",
    });
    expect(within(row).getByText("2")).toBeVisible();
    expect(within(row).getByText("4")).toBeVisible();
    expect(within(row).getByText("Blocked")).toBeVisible();
    expect(within(row).getByText("+25%")).toBeVisible();
    expect(screen.getByText("Customers affected").parentElement).toHaveTextContent("2");
  });

  it("serializes feature filters and opens exact typed evidence", async () => {
    const selectFeature = vi.fn();
    const fetchMock = mockFeatures();
    renderFeatures(fetchMock, { selectFeature });

    await screen.findByRole("option", { name: "Feature Need (4)" });
    fireEvent.change(await screen.findByLabelText("Signal filter"), {
      target: { value: "feature_need" },
    });
    await waitFor(() => expect(window.location.search).toContain("featureSignal=feature_need"));

    fireEvent.click(
      await screen.findByRole("row", { name: "Open feature Fresh results after indexing" }),
    );
    expect(selectFeature).toHaveBeenCalledWith("freshness-gap");

    renderFeatures(fetchMock, { selectedFeatureKey: "freshness-gap" });
    expect(
      await screen.findByRole("heading", { name: "Fresh results after indexing" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Underlying evidence" })).toBeVisible();
    expect(screen.getByText("Results need to include newly indexed documents")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Affected customers" })).toBeVisible();
  });

  it("keeps workflow mutation editor-only", async () => {
    const fetchMock = mockFeatures();
    renderFeatures(fetchMock, {
      data: dashboardFixture({ currentRole: "member" }),
      selectedFeatureKey: "freshness-gap",
    });

    expect(await screen.findByText(/owner or admin can connect this evidence/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "File GitHub issue" })).not.toBeInTheDocument();
  });

  it("files an issue through the linked feedback group rather than the feature key", async () => {
    const fetchMock = mockFeatures();
    renderFeatures(fetchMock, { selectedFeatureKey: "freshness-gap" });

    fireEvent.click(await screen.findByRole("button", { name: "File GitHub issue" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/groups/report-group-freshness/github-issue"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

function renderFeatures(
  fetchMock: ReturnType<typeof mockFeatures>,
  overrides: Partial<Parameters<typeof FeaturesView>[0]> = {},
) {
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FeaturesView
        data={dashboardFixture()}
        selectedFeatureKey={null}
        selectFeature={vi.fn()}
        openCustomer={vi.fn()}
        openFeedback={vi.fn()}
        openInteraction={vi.fn()}
        openSession={vi.fn()}
        refresh={vi.fn().mockResolvedValue(undefined)}
        setNotice={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

function mockFeatures() {
  return vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/api/groups/") && init?.method === "POST") {
      return Promise.resolve(
        json({
          repoFullName: "epode/example",
          issueNumber: 18,
          url: "https://github.com/epode/example/issues/18",
          state: "open",
        }),
      );
    }
    if (path.startsWith("/api/dashboard/features/")) {
      return Promise.resolve(json(featureDetailFixture()));
    }
    if (path.startsWith("/api/dashboard/features?")) {
      return Promise.resolve(json(featuresPageFixture()));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
