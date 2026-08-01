"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { ShownSecrets } from "@/components/dashboard/types";
import {
  Metrics,
  NativeSelect,
  PageHeader,
  Panel,
  StatusMessage,
} from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/api/client";
import type {
  ApiKey,
  ApiKeyCreatedResponse,
  ApiKeyRotatedResponse,
  CreateApiKeyInput,
  DashboardData,
} from "@/lib/api/dashboard";
import { copyText } from "@/lib/dashboard/clipboard";
import { formatDate, isEditor, titleCase } from "@/lib/dashboard/format";
import {
  READ_CLIENTS,
  type ReadClient,
  SETUP_SURFACES,
  type SetupStack,
  type SetupSurface,
  setupAgentPrompt,
  setupInstructions,
  stackName,
} from "./instructions";

const readKeySchema = z.object({
  label: z.string().trim().max(80),
  expiresInSeconds: z.enum(["2592000", "7776000", "31536000", "never"]),
});

const WRITE_KEY_ENSURE_PREFIX = "agent-feedback:write-key-ensured:";
const fallbackWriteKeyEnsureState = new Map<string, "pending" | "done">();

export function SetupView({
  data,
  secrets,
  rememberSecret,
  refresh,
  setNotice,
  embedded = false,
}: {
  data: DashboardData;
  secrets: ShownSecrets | null;
  rememberSecret: (kind: "write" | "read", secret: string) => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
  embedded?: boolean;
}) {
  const [surface, setSurface] = useState<SetupSurface>("mcp");
  const [stack, setStack] = useState<SetupStack>("node-mcp");
  const [readClient, setReadClient] = useState<ReadClient>("claude-code");
  const [error, setError] = useState("");
  const [creatingWriteKey, setCreatingWriteKey] = useState(false);
  const environment = data.currentEnvironment;
  const writeKeys = data.apiKeys.filter((key) => key.kind !== "read");
  const readKeys = data.apiKeys.filter((key) => key.kind === "read");
  const writeKey = writeKeys[0];
  const origin = typeof window === "undefined" ? "https://app.epode.ai" : window.location.origin;
  const integration = setupInstructions(stack, surface, origin);
  const agentPrompt = setupAgentPrompt(surface, stack, integration, origin);
  const activeReadClient = READ_CLIENTS[readClient];
  const keyInteractionCount = writeKeys.reduce((total, key) => total + key.interactionCount, 0);
  const keyReportCount = writeKeys.reduce((total, key) => total + key.reportCount, 0);
  const editor = isEditor(data.currentRole);
  const readForm = useForm<z.infer<typeof readKeySchema>>({
    resolver: zodResolver(readKeySchema),
    defaultValues: { label: "Repo read key", expiresInSeconds: "7776000" },
  });

  const createWriteKey = useCallback(
    async (allowCompletedEnsure: boolean) => {
      const environmentId = environment?.id;
      if (!environmentId || !claimWriteKeyEnsure(environmentId, allowCompletedEnsure)) return;
      setCreatingWriteKey(true);
      setError("");
      const input: CreateApiKeyInput = {
        environmentId,
        kind: "write",
        label: "Default product key",
      };
      let created: ApiKeyCreatedResponse;
      try {
        created = await apiRequest<ApiKeyCreatedResponse>("/api/settings/api-keys", {
          method: "POST",
          workspaceId: data.workspace.id,
          body: JSON.stringify(input),
        });
      } catch (caught) {
        releaseWriteKeyEnsure(environmentId);
        setError(caught instanceof Error ? caught.message : "Could not create product key");
        setCreatingWriteKey(false);
        return;
      }

      finishWriteKeyEnsure(environmentId);
      rememberSecret("write", created.secret);
      setNotice("Product key created. Save it now; it is shown once.");
      try {
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not refresh product keys");
      } finally {
        setCreatingWriteKey(false);
      }
    },
    [data.workspace.id, environment?.id, refresh, rememberSecret, setNotice],
  );

  useEffect(() => {
    const environmentId = environment?.id;
    if (!environmentId || !editor) return;
    if (writeKeys.length) {
      finishWriteKeyEnsure(environmentId);
      return;
    }
    void createWriteKey(false);
  }, [createWriteKey, editor, environment?.id, writeKeys.length]);

  const stacks = SETUP_SURFACES[surface].stacks as readonly SetupStack[];
  useEffect(() => {
    if (!stacks.includes(stack)) setStack(stacks[0]);
  }, [stack, stacks]);

  const environmentSnippet = `AGENT_FEEDBACK_KEY=${secrets?.write ?? "paste_product_key_here"}\nAGENT_FEEDBACK_MODE=${environment?.feedbackMode ?? "never_ask"}`;

  const connectionRows = useMemo(
    () =>
      data.apiKeys.map((key) => ({
        key,
        state: key.reportCount
          ? "Feedback received"
          : key.interactionCount
            ? "Connected"
            : "Never seen",
      })),
    [data.apiKeys],
  );

  if (!environment || !data.currentProduct)
    return <Panel>No product environment is selected.</Panel>;
  if (!editor) return <Panel>Only a team owner or admin can manage integrations and keys.</Panel>;
  const environmentId = environment.id;

  async function rotateKey(key: ApiKey) {
    if (!window.confirm(`Rotate ${key.label}? The old key will expire in one hour.`)) return;
    setError("");
    try {
      const rotated = await apiRequest<ApiKeyRotatedResponse>(
        `/api/settings/api-keys/${key.id}/rotate`,
        { method: "POST", workspaceId: data.workspace.id },
      );
      rememberSecret(key.kind === "read" ? "read" : "write", rotated.secret);
      setNotice(`${titleCase(key.kind)} key rotated. Update it within one hour.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rotate key");
    }
  }

  async function createReadKey(values: z.infer<typeof readKeySchema>) {
    setError("");
    try {
      const input: CreateApiKeyInput = {
        environmentId,
        kind: "read",
        label: values.label || "Repo read key",
        expiresInSeconds:
          values.expiresInSeconds === "never" ? null : Number(values.expiresInSeconds),
      };
      const created = await apiRequest<ApiKeyCreatedResponse>("/api/settings/api-keys", {
        method: "POST",
        workspaceId: data.workspace.id,
        body: JSON.stringify(input),
      });
      rememberSecret("read", created.secret);
      setNotice("Read key created. Save it now; it is shown once.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create read key");
    }
  }

  async function copy(value: string) {
    try {
      await copyText(value);
      setNotice("Copied to clipboard.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not copy");
    }
  }

  const legacyKey = writeKey && !/^af_(live|read)_[0-9a-f]{8}$/.test(writeKey.prefix);

  return (
    <div className="flex flex-col gap-6">
      {embedded ? null : (
        <PageHeader
          eyebrow="Setup"
          title={`Connect ${data.currentProduct.name}`}
          description={keyInteractionCount ? "Receiving data" : "Not connected"}
        />
      )}
      <Metrics
        items={[
          {
            label: "Product key",
            value: writeKey ? "Ready" : creatingWriteKey ? "Preparing" : "Missing",
          },
          { label: "Telemetry", value: keyInteractionCount ? "Connected" : "Waiting" },
          { label: "Agent feedback", value: keyReportCount ? "Received" : "Waiting" },
        ]}
      />
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {legacyKey ? (
        <StatusMessage tone="error">
          This legacy key cannot produce valid afr2 capabilities. Rotate it and update
          AGENT_FEEDBACK_KEY.
        </StatusMessage>
      ) : null}

      <Panel title="1. Choose an integration">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SETUP_SURFACES) as SetupSurface[]).map((item) => (
            <Button
              key={item}
              variant={surface === item ? "default" : "outline"}
              onClick={() => setSurface(item)}
            >
              {SETUP_SURFACES[item].name}
            </Button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{SETUP_SURFACES[surface].description}</p>
        <div className="flex flex-wrap gap-2">
          {stacks.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={stack === item ? "secondary" : "outline"}
              onClick={() => setStack(item)}
            >
              {stackName(item)}
            </Button>
          ))}
        </div>
      </Panel>

      <Panel title={`2. Install ${stackName(stack)}`}>
        {secrets?.write ? (
          <SecretCallout label="Save this server-side key now" secret={secrets.write} copy={copy} />
        ) : writeKey ? (
          <p className="text-sm text-muted-foreground">
            {writeKey.prefix}… is ready. Rotate it if the full value was not saved.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {creatingWriteKey ? "Preparing a product key…" : "No product key is active."}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={creatingWriteKey}
              onClick={() => void createWriteKey(true)}
            >
              {creatingWriteKey ? "Creating product key…" : "Create product key"}
            </Button>
          </div>
        )}
        <CodeBlock label="Server environment" value={environmentSnippet} copy={copy} />
        <CodeBlock label="Coding-agent setup prompt" value={agentPrompt} copy={copy} />
        <CodeBlock label="Install" value={integration.install} copy={copy} />
        <CodeBlock label="Configure once" value={integration.code} copy={copy} />
        <p className="text-sm">Verify: {integration.verify}</p>
        <p className="text-sm">
          <a className="underline" href="https://docs.epode.ai" target="_blank" rel="noreferrer">
            Integration docs
          </a>
          {" · "}
          <a
            className="underline"
            href="/.well-known/agent-feedback-v1.json"
            target="_blank"
            rel="noreferrer"
          >
            Protocol contract
          </a>
        </p>
      </Panel>

      <Panel title="3. Verify">
        <p>
          {keyInteractionCount
            ? `${keyInteractionCount} interaction(s) received.`
            : "Waiting for the first interaction."}
        </p>
        <p>
          {keyReportCount
            ? `${keyReportCount} feedback report(s) received.`
            : "Waiting for agent feedback."}
        </p>
        <Button variant="outline" onClick={() => void refresh()}>
          Check now
        </Button>
      </Panel>

      <Panel title={`Product keys (${data.apiKeys.length})`}>
        <div className="flex flex-col gap-3">
          {connectionRows.map(({ key, state }) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0"
              key={key.id}
            >
              <div>
                <p className="font-medium">
                  {key.label} · {titleCase(key.kind)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {key.prefix}… · created {formatDate(key.createdAt)} · expires{" "}
                  {formatDate(key.expiresAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : "Never used"} ·{" "}
                  {state}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void rotateKey(key)}>
                Rotate
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Read key for MCP clients">
        <p className="text-sm text-muted-foreground">
          Read keys can retrieve this product&apos;s feedback but cannot submit it.
        </p>
        <form
          className="grid max-w-xl gap-3 sm:grid-cols-3"
          onSubmit={readForm.handleSubmit(createReadKey)}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="read-key-label">Label</Label>
            <Input id="read-key-label" {...readForm.register("label")} />
          </div>
          <label className="flex flex-col gap-1 text-sm" htmlFor="read-key-expiration">
            <span>Expires</span>
            <NativeSelect id="read-key-expiration" {...readForm.register("expiresInSeconds")}>
              <option value="2592000">30 days</option>
              <option value="7776000">90 days</option>
              <option value="31536000">1 year</option>
              <option value="never">Never</option>
            </NativeSelect>
          </label>
          <Button className="self-end" type="submit" disabled={readForm.formState.isSubmitting}>
            Create read key
          </Button>
        </form>
        {secrets?.read ? (
          <>
            <SecretCallout label="Save this read key now" secret={secrets.read} copy={copy} />
            <CodeBlock
              label="Client environment"
              value={`AGENT_FEEDBACK_READ_KEY=${secrets.read}`}
              copy={copy}
            />
          </>
        ) : null}
        {readKeys.length ? (
          <>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(READ_CLIENTS) as ReadClient[]).map((client) => (
                <Button
                  type="button"
                  size="sm"
                  variant={readClient === client ? "secondary" : "outline"}
                  key={client}
                  onClick={() => setReadClient(client)}
                >
                  {READ_CLIENTS[client].name}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">{activeReadClient.note}</p>
            <CodeBlock
              label={`${activeReadClient.name} MCP config`}
              value={activeReadClient.config(origin)}
              copy={copy}
            />
          </>
        ) : null}
      </Panel>
    </div>
  );
}

function writeKeyEnsureStorageKey(environmentId: string) {
  return `${WRITE_KEY_ENSURE_PREFIX}${environmentId}`;
}

function claimWriteKeyEnsure(environmentId: string, allowCompletedEnsure = false): boolean {
  const key = writeKeyEnsureStorageKey(environmentId);
  try {
    const state = window.sessionStorage.getItem(key);
    if (state === "pending" || (state === "done" && !allowCompletedEnsure)) return false;
    window.sessionStorage.setItem(key, "pending");
    return true;
  } catch {
    const state = fallbackWriteKeyEnsureState.get(key);
    if (state === "pending" || (state === "done" && !allowCompletedEnsure)) return false;
    fallbackWriteKeyEnsureState.set(key, "pending");
    return true;
  }
}

function finishWriteKeyEnsure(environmentId: string) {
  const key = writeKeyEnsureStorageKey(environmentId);
  try {
    window.sessionStorage.setItem(key, "done");
  } catch {
    fallbackWriteKeyEnsureState.set(key, "done");
  }
}

function releaseWriteKeyEnsure(environmentId: string) {
  const key = writeKeyEnsureStorageKey(environmentId);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    fallbackWriteKeyEnsureState.delete(key);
  }
}

function SecretCallout({
  label,
  secret,
  copy,
}: {
  label: string;
  secret: string;
  copy: (value: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div>
        <strong>{label}</strong>
        <code className="mt-1 block break-all">{secret}</code>
        <small className="text-muted-foreground">This secret is shown once.</small>
      </div>
      <Button type="button" variant="outline" onClick={() => void copy(secret)}>
        Copy key
      </Button>
    </div>
  );
}

function CodeBlock({
  label,
  value,
  copy,
}: {
  label: string;
  value: string;
  copy: (value: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{label}</h3>
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
        <code>{value}</code>
      </pre>
      <Button type="button" size="sm" variant="outline" onClick={() => void copy(value)}>
        Copy
      </Button>
    </div>
  );
}
