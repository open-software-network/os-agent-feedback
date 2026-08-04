"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import {
  EmptyState,
  ErrorState,
  NativeSelect,
  Panel,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type CreateDataDestinationInput,
  createDataDestination,
  type DataDestination,
  type DataDestinationSyncRun,
  deleteDataDestination,
  fetchDataDestinationRuns,
  fetchDataDestinations,
  syncDataDestination,
  testDataDestination,
  updateDataDestination,
} from "@/lib/api/data-destinations";
import { formatDate } from "@/lib/dashboard/format";

/**
 * The destination catalog. Kinds the backend exports today are `available`;
 * the rest render as planned tiles so the picker already reads as "your data
 * system", not "a list of SaaS apps".
 */
const DESTINATION_KINDS = [
  {
    kind: "postgres",
    name: "PostgreSQL",
    group: "Data systems",
    description: "Any PostgreSQL-compatible database. Epode upserts an export table.",
    available: true,
  },
  {
    kind: "http_ndjson",
    name: "HTTP collector (NDJSON)",
    group: "Data systems",
    description: "Lake or warehouse ingestion endpoint that accepts newline-delimited JSON.",
    available: true,
  },
  { kind: "snowflake", name: "Snowflake", group: "Data systems", available: false },
  { kind: "bigquery", name: "BigQuery", group: "Data systems", available: false },
  { kind: "redshift", name: "Redshift", group: "Data systems", available: false },
  { kind: "databricks", name: "Databricks", group: "Data systems", available: false },
  { kind: "clickhouse", name: "ClickHouse", group: "Data systems", available: false },
  { kind: "mysql", name: "MySQL", group: "Data systems", available: false },
  { kind: "s3", name: "Amazon S3", group: "Object storage", available: false },
  { kind: "gcs", name: "Google Cloud Storage", group: "Object storage", available: false },
] as const;

type AvailableKind = "postgres" | "http_ndjson";

const SYNC_INTERVAL_OPTIONS = [
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
  { value: 3600, label: "Every hour" },
  { value: 86400, label: "Every day" },
] as const;

export function DataDestinationsPanel({
  workspaceId,
  editable,
}: {
  workspaceId: string;
  editable: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedKind, setSelectedKind] = useState<AvailableKind | null>(null);
  const destinationsQuery = useQuery({
    queryKey: ["data-destinations", workspaceId],
    queryFn: () => fetchDataDestinations(workspaceId),
    // A running sync flips to finished without further user input; poll while
    // any destination shows activity so the rows settle on their own.
    refetchInterval: (query) => {
      const active =
        query.state.data?.destinations?.some(
          (destination) => destination.syncing || destination.lastRun?.status === "running",
        ) ?? false;
      return active ? 2_000 : false;
    },
  });

  const destinations = destinationsQuery.data?.destinations ?? [];

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Data destinations</h2>
          <p className="text-sm text-muted-foreground">
            Continuously pipe this team&apos;s feedback reports and product interactions into your
            own data system — your warehouse, lake, or database.
          </p>
        </div>
        {editable ? (
          <Button
            type="button"
            variant="outline"
            aria-expanded={pickerOpen}
            onClick={() => {
              setPickerOpen((open) => !open);
              setSelectedKind(null);
            }}
          >
            {pickerOpen ? "Close destination picker" : "Add a data destination"}
          </Button>
        ) : null}
      </div>

      {!editable ? (
        <p className="text-sm text-muted-foreground">
          Only a team owner or admin can configure data destinations.
        </p>
      ) : null}

      {pickerOpen && editable ? (
        selectedKind ? (
          <DestinationForm
            key={selectedKind}
            workspaceId={workspaceId}
            kind={selectedKind}
            onBack={() => setSelectedKind(null)}
            onCreated={() => {
              setSelectedKind(null);
              setPickerOpen(false);
            }}
          />
        ) : (
          <DestinationKindPicker onSelect={(kind) => setSelectedKind(kind)} />
        )
      ) : null}

      {destinationsQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading data destinations…</p>
      ) : destinationsQuery.isError ? (
        <ErrorState error={destinationsQuery.error} onRetry={() => destinationsQuery.refetch()} />
      ) : destinations.length ? (
        <div className="space-y-3">
          {destinations.map((destination) => (
            <DestinationRow
              key={destination.id}
              workspaceId={workspaceId}
              destination={destination}
              editable={editable}
            />
          ))}
        </div>
      ) : pickerOpen ? null : (
        <EmptyState
          title="No data destinations"
          description="Add a destination to start piping feedback data into your data system."
        />
      )}
    </Panel>
  );
}

function DestinationKindPicker({ onSelect }: { onSelect: (kind: AvailableKind) => void }) {
  const groups = new Map<string, (typeof DESTINATION_KINDS)[number][]>();
  for (const kind of DESTINATION_KINDS) {
    const group = groups.get(kind.group) ?? [];
    group.push(kind);
    groups.set(kind.group, group);
  }

  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div>
        <h3 className="font-medium">Select a destination</h3>
        <p className="text-sm text-muted-foreground">
          Choose the data system where Epode should continuously deliver this team&apos;s data.
        </p>
      </div>
      {[...groups.entries()].map(([group, kinds]) => (
        <div className="space-y-2" key={group}>
          <h4 className="text-sm font-medium">{group}</h4>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {kinds.map((kind) => (
              <li key={kind.kind}>
                <button
                  type="button"
                  className="flex h-full w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!kind.available}
                  aria-disabled={!kind.available}
                  aria-label={kind.available ? `Configure ${kind.name}` : `${kind.name} (planned)`}
                  onClick={() => {
                    if (kind.available) onSelect(kind.kind as AvailableKind);
                  }}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="font-medium">{kind.name}</span>
                    {kind.available ? null : (
                      <span className="text-xs text-muted-foreground">Planned</span>
                    )}
                  </span>
                  {"description" in kind && kind.description ? (
                    <span className="text-xs text-muted-foreground">{kind.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function DestinationForm({
  workspaceId,
  kind,
  onBack,
  onCreated,
}: {
  workspaceId: string;
  kind: AvailableKind;
  onBack: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [schema, setSchema] = useState("");
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [syncIntervalSeconds, setSyncIntervalSeconds] = useState(300);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; detail: string } | null>(null);

  const queryClient = useQueryClient();
  const testMutation = useMutation({
    mutationFn: (input: CreateDataDestinationInput) =>
      testDataDestination(workspaceId, {
        kind: input.kind,
        config: input.config,
        credentials: input.credentials,
      }),
    onSuccess: (result) => setTestStatus({ ok: result.ok, detail: result.detail }),
    onError: (error) => setTestStatus({ ok: false, detail: error.message }),
  });
  const createMutation = useMutation({
    mutationFn: (input: CreateDataDestinationInput) => createDataDestination(workspaceId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["data-destinations", workspaceId] });
      onCreated();
    },
  });

  const kindName = DESTINATION_KINDS.find((entry) => entry.kind === kind)?.name ?? kind;
  const busy = testMutation.isPending || createMutation.isPending;

  function buildInput(): CreateDataDestinationInput {
    const trimmedName = name.trim();
    if (kind === "postgres") {
      return {
        name: trimmedName,
        kind,
        config: {
          connectionUrl: connectionUrl.trim(),
          ...(schema.trim() ? { schema: schema.trim() } : {}),
        },
        credentials: password ? { password } : undefined,
        syncIntervalSeconds,
      };
    }
    return {
      name: trimmedName,
      kind,
      config: { url: url.trim() },
      credentials: token ? { token } : undefined,
      syncIntervalSeconds,
    };
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTestStatus(null);
    createMutation.mutate(buildInput());
  }

  return (
    <form className="space-y-4 rounded-xl border p-4" onSubmit={submit}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Connect {kindName}</h3>
          <p className="text-sm text-muted-foreground">
            Epode creates and maintains an export of feedback reports and product interactions in
            this destination.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onBack} disabled={busy}>
          Choose a different destination
        </Button>
      </div>

      <div className="space-y-1">
        <Label htmlFor="destination-name">Destination name</Label>
        <Input
          id="destination-name"
          className="max-w-xl"
          value={name}
          required
          maxLength={120}
          placeholder="Analytics warehouse"
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      {kind === "postgres" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="destination-connection-url">Connection URL</Label>
            <Input
              id="destination-connection-url"
              className="max-w-xl"
              value={connectionUrl}
              required
              placeholder="postgres://loader@warehouse.internal:5432/analytics"
              disabled={busy}
              onChange={(event) => setConnectionUrl(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Without a password — that goes in the credentials field below.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="destination-schema">Schema (optional)</Label>
            <Input
              id="destination-schema"
              className="max-w-xl"
              value={schema}
              placeholder="public"
              disabled={busy}
              onChange={(event) => setSchema(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="destination-password">Password (optional)</Label>
            <Input
              id="destination-password"
              className="max-w-xl"
              type="password"
              value={password}
              autoComplete="new-password"
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Stored sealed and never returned by the API.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor="destination-url">Collector URL</Label>
            <Input
              id="destination-url"
              className="max-w-xl"
              value={url}
              required
              placeholder="https://ingest.example.com/epode"
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Receives NDJSON POST batches, one JSON record per line.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="destination-token">Bearer token (optional)</Label>
            <Input
              id="destination-token"
              className="max-w-xl"
              type="password"
              value={token}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Sent as an Authorization header. Stored sealed and never returned by the API.
            </p>
          </div>
        </>
      )}

      <div className="space-y-1">
        <Label htmlFor="destination-sync-interval">Sync cadence</Label>
        <NativeSelect
          id="destination-sync-interval"
          className="w-full max-w-xl"
          value={String(syncIntervalSeconds)}
          disabled={busy}
          onChange={(event) => setSyncIntervalSeconds(Number(event.target.value))}
        >
          {SYNC_INTERVAL_OPTIONS.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !name.trim()}
          onClick={() => testMutation.mutate(buildInput())}
        >
          {testMutation.isPending ? "Testing…" : "Test connection"}
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {createMutation.isPending ? "Saving…" : "Save destination"}
        </Button>
      </div>
      {testStatus ? (
        <StatusMessage tone={testStatus.ok ? "status" : "error"}>
          {testStatus.ok ? `Connection OK — ${testStatus.detail}` : testStatus.detail}
        </StatusMessage>
      ) : null}
      {createMutation.isError ? (
        <StatusMessage tone="error">{createMutation.error.message}</StatusMessage>
      ) : null}
    </form>
  );
}

function runTone(run: DataDestinationSyncRun | null): { label: string; danger: boolean } {
  if (!run) return { label: "Never synced", danger: false };
  if (run.status === "running") return { label: "Syncing…", danger: false };
  if (run.status === "failed") return { label: "Last sync failed", danger: true };
  return { label: "Healthy", danger: false };
}

function DestinationRow({
  workspaceId,
  destination,
  editable,
}: {
  workspaceId: string;
  destination: DataDestination;
  editable: boolean;
}) {
  const [runsOpen, setRunsOpen] = useState(false);
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["data-destinations", workspaceId] });
  const syncMutation = useMutation({
    mutationFn: () => syncDataDestination(workspaceId, destination.id),
    onSettled: invalidate,
  });
  const toggleMutation = useMutation({
    mutationFn: () =>
      updateDataDestination(workspaceId, destination.id, { enabled: !destination.enabled }),
    onSettled: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteDataDestination(workspaceId, destination.id),
    onSettled: invalidate,
  });
  const runsQuery = useQuery({
    queryKey: ["data-destination-runs", workspaceId, destination.id],
    queryFn: () => fetchDataDestinationRuns(workspaceId, destination.id),
    enabled: runsOpen,
    refetchInterval: destination.syncing ? 2_000 : false,
  });

  const kindName =
    DESTINATION_KINDS.find((entry) => entry.kind === destination.kind)?.name ?? destination.kind;
  const tone = runTone(destination.lastRun ?? null);
  const busy = syncMutation.isPending || toggleMutation.isPending || deleteMutation.isPending;
  const mutationError = syncMutation.error ?? toggleMutation.error ?? deleteMutation.error;
  const syncing = destination.syncing || destination.lastRun?.status === "running";

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <dt className="text-muted-foreground">Destination</dt>
            <dd className="font-medium">{destination.name}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{kindName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd className={tone.danger ? "text-destructive" : undefined}>
              {destination.enabled ? (syncing ? "Syncing…" : tone.label) : "Paused"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last sync</dt>
            <dd>{destination.lastRun ? formatDate(destination.lastRun.startedAt) : "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Records exported</dt>
            <dd>{destination.lastRun ? destination.lastRun.recordsExported : "—"}</dd>
          </div>
        </dl>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || syncing}
              onClick={() => syncMutation.mutate()}
            >
              {syncMutation.isPending ? "Starting…" : "Sync now"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => toggleMutation.mutate()}
            >
              {destination.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={runsOpen}
              onClick={() => setRunsOpen((open) => !open)}
            >
              {runsOpen ? "Hide runs" : "Show runs"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => deleteMutation.mutate()}
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>

      {destination.lastRun?.status === "failed" && destination.lastRun.error ? (
        <StatusMessage tone="error">{destination.lastRun.error}</StatusMessage>
      ) : null}
      {mutationError ? <StatusMessage tone="error">{mutationError.message}</StatusMessage> : null}

      {runsOpen ? (
        runsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading runs…</p>
        ) : runsQuery.isError ? (
          <ErrorState error={runsQuery.error} onRetry={() => runsQuery.refetch()} />
        ) : runsQuery.data?.runs.length ? (
          <ul className="divide-y rounded-xl border">
            {runsQuery.data.runs.map((run) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                key={run.id}
              >
                <span>
                  {formatDate(run.startedAt)} · {run.trigger === "manual" ? "Manual" : "Scheduled"}
                </span>
                <span
                  className={run.status === "failed" ? "text-destructive" : "text-muted-foreground"}
                >
                  {run.status === "running"
                    ? "Running…"
                    : run.status === "failed"
                      ? `Failed — ${run.error ?? "unknown error"}`
                      : `${run.recordsExported} records`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sync runs yet.</p>
        )
      ) : null}
    </section>
  );
}
