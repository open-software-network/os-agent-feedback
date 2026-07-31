"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorState, Panel, StatusMessage } from "@/components/dashboard/view-primitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { fetchProductGithubRepo } from "@/lib/api/connectors";
import type { DashboardData } from "@/lib/api/dashboard";
import {
  fetchProductGroupsWindow,
  fileGroupGithubIssue,
  type ProductReportGroup,
} from "@/lib/api/groups";
import { formatDate, isEditor, titleCase } from "@/lib/dashboard/format";

const GROUP_LOAD_INCREMENT = 50;

export function FeedbackGroups({ data }: { data: DashboardData }) {
  const [groupLimit, setGroupLimit] = useState(GROUP_LOAD_INCREMENT);
  const product = data.currentProduct;
  const editable = isEditor(data.currentRole);
  const queryEnabled = Boolean(product && editable);
  const groupsQuery = useQuery({
    queryKey: ["product-groups", data.workspace.id, product?.id, groupLimit],
    queryFn: () => fetchProductGroupsWindow(data.workspace.id, product?.id ?? "", groupLimit),
    enabled: queryEnabled,
    gcTime: 0,
  });
  const mappingQuery = useQuery({
    queryKey: ["product-github-repo", data.workspace.id, product?.id],
    queryFn: () => fetchProductGithubRepo(data.workspace.id, product?.id ?? ""),
    enabled: queryEnabled,
  });
  const filingMutation = useMutation({
    mutationFn: (groupKey: string) => fileGroupGithubIssue(data.workspace.id, groupKey),
    onSuccess: () => groupsQuery.refetch(),
  });

  if (!editable) return null;
  if (!product) {
    return <Panel title="Feedback groups">Select a product to view grouped feedback.</Panel>;
  }
  if (groupsQuery.isPending || mappingQuery.isPending) {
    return <Panel title="Feedback groups">Loading grouped feedback…</Panel>;
  }
  if (groupsQuery.isError) {
    return <ErrorState error={groupsQuery.error} onRetry={() => groupsQuery.refetch()} />;
  }
  if (mappingQuery.isError) {
    return <ErrorState error={mappingQuery.error} onRetry={() => mappingQuery.refetch()} />;
  }

  const mutationGroupKey = filingMutation.variables;
  const mutationError = filingMutation.error;
  const pendingMessage =
    mutationError instanceof ApiError && mutationError.status === 409
      ? mutationError.message
      : null;
  const filingError = mutationError && !pendingMessage ? mutationError.message : null;
  const connectorsHref = connectorsPath(data.workspace.id, product.id);

  async function checkAgain() {
    await groupsQuery.refetch();
    filingMutation.reset();
  }

  return (
    <FeedbackGroupRollup
      groups={groupsQuery.data.groups}
      hasMore={groupsQuery.data.hasMore}
      mappingAvailable={Boolean(mappingQuery.data)}
      connectorsHref={connectorsHref}
      mutationGroupKey={mutationGroupKey}
      filingPending={filingMutation.isPending}
      pendingMessage={pendingMessage}
      filingError={filingError}
      fileIssue={(groupKey) => filingMutation.mutate(groupKey)}
      checkAgain={() => void checkAgain()}
      loadMore={() => {
        filingMutation.reset();
        setGroupLimit((current) => current + GROUP_LOAD_INCREMENT);
      }}
    />
  );
}

function FeedbackGroupRollup({
  groups,
  hasMore,
  mappingAvailable,
  connectorsHref,
  mutationGroupKey,
  filingPending,
  pendingMessage,
  filingError,
  fileIssue,
  checkAgain,
  loadMore,
}: {
  groups: ProductReportGroup[];
  hasMore: boolean;
  mappingAvailable: boolean;
  connectorsHref: string;
  mutationGroupKey: string | undefined;
  filingPending: boolean;
  pendingMessage: string | null;
  filingError: string | null;
  fileIssue: (groupKey: string) => void;
  checkAgain: () => void;
  loadMore: () => void;
}) {
  return (
    <Panel title="Feedback groups">
      <p className="text-sm text-muted-foreground">
        Similar reports are grouped by a stable, explainable fingerprint.
      </p>
      {!mappingAvailable && groups.some((group) => !group.githubIssue) ? (
        <StatusMessage>
          Map this product to a GitHub repository before filing an issue.{" "}
          <a className={buttonVariants({ variant: "link", size: "sm" })} href={connectorsHref}>
            Open Connectors
          </a>
        </StatusMessage>
      ) : null}

      {groups.length ? (
        <div className="space-y-3">
          {groups.map((group) => {
            const mutationMatches = mutationGroupKey === group.groupKey;
            return (
              <article className="space-y-3 rounded-xl border p-4" key={group.groupKey}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{group.groupKey}</h3>
                    <p className="text-sm text-muted-foreground">
                      {group.reportCount} {group.reportCount === 1 ? "report" : "reports"} · latest{" "}
                      {formatDate(group.latestOccurredAt)}
                    </p>
                  </div>
                  {group.githubIssue ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        className="text-sm underline underline-offset-4"
                        href={group.githubIssue.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {group.githubIssue.repoFullName}#{group.githubIssue.issueNumber}
                      </a>
                      <span className="rounded-lg border px-2 py-1 text-xs">
                        {titleCase(group.githubIssue.state)}
                      </span>
                    </div>
                  ) : mappingAvailable ? (
                    <Button
                      type="button"
                      disabled={filingPending}
                      aria-busy={filingPending && mutationMatches}
                      onClick={() => fileIssue(group.groupKey)}
                    >
                      {filingPending && mutationMatches ? "Filing…" : "File GitHub issue"}
                    </Button>
                  ) : null}
                </div>
                <p className="text-sm">{group.explanation}</p>
                {mutationMatches && pendingMessage ? (
                  <StatusMessage>
                    {pendingMessage}{" "}
                    <Button type="button" variant="outline" size="sm" onClick={checkAgain}>
                      Check again
                    </Button>
                  </StatusMessage>
                ) : null}
                {mutationMatches && filingError ? (
                  <StatusMessage tone="error">{filingError}</StatusMessage>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No feedback groups are available for this product.
        </p>
      )}

      {hasMore ? (
        <Button type="button" variant="outline" onClick={loadMore}>
          Load more
        </Button>
      ) : null}
    </Panel>
  );
}

function connectorsPath(workspaceId: string, productId: string): string {
  const params = new URLSearchParams({ view: "connectors", team: workspaceId, product: productId });
  return `/?${params}`;
}
