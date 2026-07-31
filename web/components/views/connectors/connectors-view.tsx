"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ViewBaseProps } from "@/components/dashboard/types";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  fetchGithubInstallations,
  fetchGithubRepositories,
  type GithubInstallation,
  type GithubInstallationsResponse,
  type GithubRepositoriesResponse,
} from "@/lib/api/connectors";
import { formatDate } from "@/lib/dashboard/format";

const PLANNED_CONNECTORS = ["Slack", "Linear", "OS Platform"] as const;

export function ConnectorsView({ data }: Pick<ViewBaseProps, "data">) {
  const [githubExpanded, setGithubExpanded] = useState(true);
  const installationsQuery = useQuery({
    queryKey: ["github-installations", data.workspace.id],
    queryFn: () => fetchGithubInstallations(data.workspace.id),
    enabled: githubExpanded,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title="Connectors"
        description="Connect Epode to the tools your team uses to act on product feedback."
      />

      <div className="space-y-3">
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">GitHub</h2>
              <p className="text-sm text-muted-foreground">
                View the organizations and repositories available to this workspace.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              aria-expanded={githubExpanded}
              onClick={() => setGithubExpanded((expanded) => !expanded)}
            >
              {githubExpanded ? "Hide GitHub" : "Show GitHub"}
            </Button>
          </div>

          {githubExpanded ? (
            <GithubConnector
              workspaceId={data.workspace.id}
              response={installationsQuery.data}
              pending={installationsQuery.isPending}
              error={installationsQuery.error}
              retry={() => installationsQuery.refetch()}
            />
          ) : null}
        </Panel>

        {PLANNED_CONNECTORS.map((connector) => (
          <Panel key={connector}>
            <div className="flex flex-wrap items-center justify-between gap-3" aria-disabled="true">
              <div>
                <h2 className="font-medium">{connector}</h2>
                <p className="text-sm text-muted-foreground">Planned</p>
              </div>
              <Button type="button" variant="outline" disabled aria-disabled="true">
                Planned
              </Button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function GithubConnector({
  workspaceId,
  response,
  pending,
  error,
  retry,
}: {
  workspaceId: string;
  response: GithubInstallationsResponse | undefined;
  pending: boolean;
  error: Error | null;
  retry: () => void;
}) {
  if (pending) {
    return <p className="text-sm text-muted-foreground">Loading GitHub installations…</p>;
  }
  if (error) return <ErrorState error={error} onRetry={retry} />;
  if (!response) return null;
  if (!response.configured) {
    return <StatusMessage tone="error">GitHub App is not configured on this server.</StatusMessage>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Installations</h3>
          <p className="text-sm text-muted-foreground">
            Organizations and personal accounts connected to this workspace.
          </p>
        </div>
        {/* GitHub install requires a top-level navigation; this link cannot carry x-workspace-id. */}
        <a className={buttonVariants({ variant: "outline" })} href="/api/github/install">
          Add organization
        </a>
      </div>

      {response.installations.length ? (
        <div className="space-y-3">
          {response.installations.map((installation) => (
            <InstallationRow
              key={installation.installationId}
              workspaceId={workspaceId}
              installation={installation}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No GitHub installations"
          description="Add an organization or personal account to make its repositories available."
        />
      )}
    </div>
  );
}

function InstallationRow({
  workspaceId,
  installation,
}: {
  workspaceId: string;
  installation: GithubInstallation;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="font-medium">{installation.accountLogin}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{installation.accountType}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Connected</dt>
            <dd>{formatDate(installation.createdAt)}</dd>
          </div>
        </dl>
        <Button
          type="button"
          variant="outline"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} repositories for ${installation.accountLogin}`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide repositories" : "Show repositories"}
        </Button>
      </div>

      {expanded ? (
        <InstallationRepositories
          workspaceId={workspaceId}
          installationId={installation.installationId}
        />
      ) : null}
    </section>
  );
}

function InstallationRepositories({
  workspaceId,
  installationId,
}: {
  workspaceId: string;
  installationId: number;
}) {
  const repositoriesQuery = useQuery({
    queryKey: ["github-repos", workspaceId, installationId],
    queryFn: () => fetchGithubRepositories(workspaceId, installationId),
  });

  if (repositoriesQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Loading repositories…</p>;
  }
  if (repositoriesQuery.isError) {
    return (
      <ErrorState error={repositoriesQuery.error} onRetry={() => repositoriesQuery.refetch()} />
    );
  }
  return <RepositoriesList response={repositoriesQuery.data} />;
}

function RepositoriesList({ response }: { response: GithubRepositoriesResponse }) {
  return (
    <div className="space-y-3">
      {response.truncated ? (
        <StatusMessage>
          This is a partial repository list because GitHub's 1,000-repository limit was reached.
        </StatusMessage>
      ) : null}
      {response.repositories.length ? (
        <ul className="divide-y rounded-xl border">
          {response.repositories.map((repository) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 p-3"
              key={repository.fullName}
            >
              <span className="font-medium">{repository.fullName}</span>
              <span className="text-sm text-muted-foreground">
                {repository.defaultBranch} · {repository.private ? "Private" : "Public"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          This installation does not expose any repositories.
        </p>
      )}
    </div>
  );
}
