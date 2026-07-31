"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";

import type { ViewBaseProps } from "@/components/dashboard/types";
import {
  EmptyState,
  ErrorState,
  NativeSelect,
  PageHeader,
  Panel,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  clearProductGithubRepo,
  fetchGithubInstallations,
  fetchGithubRepositories,
  fetchProductGithubRepo,
  type GithubInstallation,
  type GithubInstallationsResponse,
  type GithubRepositoriesResponse,
  type GithubRepository,
  type ProductGithubRepo,
  type ProductGithubRepoInput,
  setProductGithubRepo,
} from "@/lib/api/connectors";
import type { Product } from "@/lib/api/dashboard";
import { formatDate, isEditor } from "@/lib/dashboard/format";

const PLANNED_CONNECTORS = ["Slack", "Linear", "OS Platform"] as const;

export function ConnectorsView({
  data,
  embedded = false,
}: Pick<ViewBaseProps, "data"> & { embedded?: boolean }) {
  const [githubExpanded, setGithubExpanded] = useState(true);
  const [mappingExpanded, setMappingExpanded] = useState(false);
  const installationsQuery = useQuery({
    queryKey: ["github-installations", data.workspace.id],
    queryFn: () => fetchGithubInstallations(data.workspace.id),
    enabled: githubExpanded || mappingExpanded,
  });
  const editable = isEditor(data.currentRole);

  return (
    <div className="space-y-6">
      {!embedded ? (
        <PageHeader
          eyebrow="Workspace"
          title="Connectors"
          description="Connect Epode to the tools your team uses to act on product feedback."
        />
      ) : null}

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
              <Button
                type="button"
                variant="outline"
                disabled
                aria-disabled="true"
                aria-label={`${connector} planned`}
              >
                Planned
              </Button>
            </div>
          </Panel>
        ))}
      </div>

      <ProductMappingPanel
        workspaceId={data.workspace.id}
        product={data.currentProduct}
        editable={editable}
        expanded={mappingExpanded}
        setExpanded={setMappingExpanded}
        installations={installationsQuery.data}
        installationsPending={installationsQuery.isPending}
        installationsError={installationsQuery.error}
        retryInstallations={() => installationsQuery.refetch()}
      />
    </div>
  );
}

function ProductMappingPanel({
  workspaceId,
  product,
  editable,
  expanded,
  setExpanded,
  installations,
  installationsPending,
  installationsError,
  retryInstallations,
}: {
  workspaceId: string;
  product: Product | null;
  editable: boolean;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  installations: GithubInstallationsResponse | undefined;
  installationsPending: boolean;
  installationsError: Error | null;
  retryInstallations: () => void;
}) {
  const title = product ? `GitHub repository for ${product.name}` : "Product repository";

  return (
    <Panel title={title}>
      <p className="text-sm text-muted-foreground">
        Choose the repository where feedback groups from this product can become GitHub issues.
      </p>
      {!product ? <p className="text-sm">Select a product to configure its repository.</p> : null}
      {!editable ? (
        <p className="text-sm">Only a team owner or admin can configure this mapping.</p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        aria-expanded={expanded}
        aria-disabled={!editable || !product}
        disabled={!editable || !product}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Hide repository settings" : "Configure repository"}
      </Button>

      {expanded && editable && product ? (
        installationsPending ? (
          <p className="text-sm text-muted-foreground">Loading GitHub installations…</p>
        ) : installationsError ? (
          <ErrorState error={installationsError} onRetry={retryInstallations} />
        ) : !installations ? null : !installations.configured ? (
          <StatusMessage tone="error">GitHub App is not configured on this server.</StatusMessage>
        ) : (
          <ProductRepoMapping
            workspaceId={workspaceId}
            product={product}
            installations={installations.installations}
            editable={editable}
          />
        )
      ) : null}
    </Panel>
  );
}

function ProductRepoMapping({
  workspaceId,
  product,
  installations,
  editable,
}: {
  workspaceId: string;
  product: Product;
  installations: GithubInstallation[];
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const mappingKey = ["product-github-repo", workspaceId, product.id] as const;
  const [actionStatus, setActionStatus] = useState("");
  const mappingQuery = useQuery({
    queryKey: mappingKey,
    queryFn: () => fetchProductGithubRepo(workspaceId, product.id),
  });
  const repositoryQueries = useQueries({
    queries: installations.map((installation) => ({
      queryKey: ["github-repos", workspaceId, installation.installationId],
      queryFn: () => fetchGithubRepositories(workspaceId, installation.installationId),
    })),
  });
  const saveMutation = useMutation({
    mutationFn: (input: ProductGithubRepoInput) =>
      setProductGithubRepo(workspaceId, product.id, input),
    onSuccess: () => {
      return queryClient.invalidateQueries({ queryKey: mappingKey });
    },
  });
  const clearMutation = useMutation({
    mutationFn: () => clearProductGithubRepo(workspaceId, product.id),
    onSuccess: () => {
      return queryClient.invalidateQueries({ queryKey: mappingKey });
    },
  });

  if (mappingQuery.isPending || repositoryQueries.some((query) => query.isPending)) {
    return <p className="text-sm text-muted-foreground">Loading repository settings…</p>;
  }
  if (mappingQuery.isError) {
    return <ErrorState error={mappingQuery.error} onRetry={() => mappingQuery.refetch()} />;
  }
  const repositoryResponses = repositoryQueries.flatMap((query) =>
    query.data ? [query.data] : [],
  );
  const failedInstallations = repositoryQueries.flatMap((query, index) =>
    query.isError ? [installations[index].accountLogin] : [],
  );
  const options = repositoryOptions(repositoryResponses, mappingQuery.data);
  const mutationError = saveMutation.error ?? clearMutation.error;
  const busy = saveMutation.isPending || clearMutation.isPending;

  async function save(input: ProductGithubRepoInput) {
    if (!editable) return;
    setActionStatus("");
    clearMutation.reset();
    try {
      await saveMutation.mutateAsync(input);
      setActionStatus("Repository mapping saved.");
    } catch {
      // The mutation error is rendered below the form.
    }
  }

  async function clear() {
    if (!editable) return;
    setActionStatus("");
    saveMutation.reset();
    try {
      await clearMutation.mutateAsync();
      setActionStatus("Repository mapping cleared.");
    } catch {
      // The mutation error is rendered below the form.
    }
  }

  return (
    <ProductRepoMappingForm
      key={product.id}
      mapping={mappingQuery.data}
      options={options}
      truncated={repositoryResponses.some((response) => response.truncated)}
      failedInstallations={failedInstallations}
      editable={editable}
      busy={busy}
      error={mutationError}
      status={actionStatus}
      save={save}
      clear={clear}
      retryFailedInstallations={() => {
        void Promise.all(
          repositoryQueries.filter((query) => query.isError).map((query) => query.refetch()),
        );
      }}
    />
  );
}

type RepositoryOption = GithubRepository & { installationId: number };

function ProductRepoMappingForm({
  mapping,
  options,
  truncated,
  failedInstallations,
  editable,
  busy,
  error,
  status,
  save,
  clear,
  retryFailedInstallations,
}: {
  mapping: ProductGithubRepo | null;
  options: RepositoryOption[];
  truncated: boolean;
  failedInstallations: string[];
  editable: boolean;
  busy: boolean;
  error: Error | null;
  status: string;
  save: (input: ProductGithubRepoInput) => Promise<void>;
  clear: () => Promise<void>;
  retryFailedInstallations: () => void;
}) {
  const listedMappedOption = mapping
    ? options.find((option) => option.fullName === mapping.repoFullName)
    : undefined;
  const syntheticOption: RepositoryOption | undefined =
    mapping && !listedMappedOption
      ? {
          fullName: mapping.repoFullName,
          installationId: mapping.installationId,
          defaultBranch: mapping.defaultBranch,
          // Visibility is unknown here; use the conservative value without displaying it.
          private: true,
        }
      : undefined;
  const effectiveOptions = syntheticOption ? [syntheticOption, ...options] : options;
  const mappedOption = mapping
    ? effectiveOptions.find((option) => option.fullName === mapping.repoFullName)
    : undefined;
  const initialRepo = mappedOption?.fullName ?? "";
  const [repoFullName, setRepoFullName] = useState(initialRepo);
  const [defaultBranch, setDefaultBranch] = useState(mapping?.defaultBranch ?? "");
  const [pathPrefix, setPathPrefix] = useState(mapping?.pathPrefix ?? "");

  useEffect(() => {
    setRepoFullName(initialRepo);
    setDefaultBranch(mapping?.defaultBranch ?? "");
    setPathPrefix(mapping?.pathPrefix ?? "");
  }, [initialRepo, mapping?.defaultBranch, mapping?.pathPrefix]);

  function selectRepository(fullName: string) {
    setRepoFullName(fullName);
    const selected = effectiveOptions.find((option) => option.fullName === fullName);
    setDefaultBranch(selected?.defaultBranch ?? "");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable) return;
    const selected = effectiveOptions.find((option) => option.fullName === repoFullName);
    const branch = defaultBranch.trim();
    if (!selected || !branch) return;
    void save({
      installationId: selected.installationId,
      repoFullName: selected.fullName,
      defaultBranch: branch,
      pathPrefix: pathPrefix.trim() || null,
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      {mapping ? (
        <StatusMessage>
          Currently mapped to {mapping.repoFullName} on {mapping.defaultBranch}.
        </StatusMessage>
      ) : (
        <p className="text-sm text-muted-foreground">This product has no repository mapping.</p>
      )}

      <div className="space-y-1">
        <Label htmlFor="github-repository">Repository</Label>
        <NativeSelect
          id="github-repository"
          className="w-full max-w-xl"
          value={repoFullName}
          disabled={!editable || busy || !effectiveOptions.length}
          onChange={(event) => selectRepository(event.target.value)}
        >
          <option value="">Select a repository</option>
          {effectiveOptions.map((option) => (
            <option key={option.fullName} value={option.fullName}>
              {option.fullName}
              {option === syntheticOption ? " (not in the current listing)" : ""}
            </option>
          ))}
        </NativeSelect>
        {truncated ? (
          <p className="text-sm text-muted-foreground">
            This repository list is partial because at least one installation reached GitHub&apos;s
            1,000-repository limit. The repository you need may not be listed.
          </p>
        ) : null}
        {failedInstallations.length ? (
          <StatusMessage tone="error">
            Could not load repositories for {failedInstallations.join(", ")}. Repositories from
            other installations are still available.{" "}
            <Button type="button" variant="outline" size="sm" onClick={retryFailedInstallations}>
              Retry failed installations
            </Button>
          </StatusMessage>
        ) : null}
        {!options.length ? (
          <p className="text-sm text-muted-foreground">
            No repositories are available from the connected GitHub installations.
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label htmlFor="github-default-branch">Default branch</Label>
        <Input
          id="github-default-branch"
          className="max-w-xl"
          value={defaultBranch}
          required
          disabled={!editable || busy}
          onChange={(event) => setDefaultBranch(event.target.value)}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="github-path-prefix">Path prefix (optional)</Label>
        <Input
          id="github-path-prefix"
          className="max-w-xl"
          value={pathPrefix}
          placeholder="packages/api"
          disabled={!editable || busy}
          onChange={(event) => setPathPrefix(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={!editable || busy || !repoFullName || !defaultBranch.trim()}
        >
          Save mapping
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!editable || busy || !mapping}
          onClick={() => void clear()}
        >
          Clear mapping
        </Button>
      </div>
      {error ? <StatusMessage tone="error">{error.message}</StatusMessage> : null}
      {status ? <StatusMessage>{status}</StatusMessage> : null}
    </form>
  );
}

function repositoryOptions(
  responses: GithubRepositoriesResponse[],
  mapping: ProductGithubRepo | null,
): RepositoryOption[] {
  const options = new Map<string, RepositoryOption>();
  for (const response of responses) {
    for (const repository of response.repositories) {
      const preferred =
        mapping?.repoFullName === repository.fullName &&
        mapping.installationId === response.installationId;
      if (!options.has(repository.fullName) || preferred) {
        options.set(repository.fullName, {
          ...repository,
          installationId: response.installationId,
        });
      }
    }
  }
  return [...options.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
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
        {/* GitHub install requires a top-level navigation; carry workspace context in the URL. */}
        <a
          className={buttonVariants({ variant: "outline" })}
          href={`/api/github/install?workspaceId=${encodeURIComponent(workspaceId)}`}
        >
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
