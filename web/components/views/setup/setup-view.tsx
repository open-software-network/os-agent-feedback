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
  const opportunityCount = data.insights.opportunities;
  const confirmedCount = data.insights.confirmedInteractions;
  const reportCount = data.insights.reports;
  const firstOpportunityAt = data.activationMilestones?.firstOpportunityAt ?? null;
  const firstConfirmedInteractionAt =
    data.activationMilestones?.firstConfirmedInteractionAt ?? null;
  const firstReportAt = data.activationMilestones?.firstReportAt ?? null;
  const opportunityActivated = Boolean(firstOpportunityAt);
  const confirmedActivated = Boolean(firstConfirmedInteractionAt);
  const reportActivated = Boolean(firstReportAt);
  const activationDescription = reportActivated
    ? "End-to-end feedback loop proven"
    : confirmedActivated
      ? "Agent use confirmed"
      : opportunityActivated
        ? "Product route connected"
        : "Not connected";
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
          description={activationDescription}
        />
      )}
      <Metrics
        items={[
          {
            label: "Product key",
            value: writeKey ? "Ready" : creatingWriteKey ? "Preparing" : "Missing",
          },
          { label: "First opportunity", value: opportunityActivated ? "Received" : "Waiting" },
          { label: "First confirmed", value: confirmedActivated ? "Received" : "Waiting" },
          { label: "First report", value: reportActivated ? "Received" : "Waiting" },
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
          <SecretCallout
            label="Save this server-side key now"
            secret={secrets.write}
            description="Move it directly into your deployment secret manager. Never put it in a repository, shell history, browser code, mobile app, or MCP client."
            copy={copy}
          />
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
        <p className="text-sm text-muted-foreground">
          Replace the example route or tool names before deploying. Derive customerRef only from a
          stable opaque ID established by your product authentication. Add sessionRef only for a
          journey your product already knows belongs together.
        </p>
        {surface === "mcp" ? (
          <p className="text-sm text-muted-foreground">
            Customer-agent step: none. MCP exposes feedback as native tools; verify the server-level
            instructions and returned action in each agent client you support.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Customer-agent step: generic HTTP and website agents are best effort. For deterministic
            handling, test this route with the shared Epode Companion enabled in a supported agent.
            The company integration does not install anything on the customer&apos;s machine. See
            the{" "}
            <a
              className="underline"
              href="https://docs.epode.ai/quickstart#customer-agent-step"
              target="_blank"
              rel="noreferrer"
            >
              customer-agent setup
            </a>
            .
          </p>
        )}
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

      <Panel title="3. Prove activation">
        <ol className="flex flex-col gap-3">
          <ActivationMilestone
            complete={opportunityActivated}
            title="First opportunity"
            detail={
              firstOpportunityAt
                ? opportunityCount
                  ? `First received ${formatDate(firstOpportunityAt)} · ${opportunityCount} product interaction(s) in the last ${data.insights.windowDays} days.`
                  : `First received ${formatDate(firstOpportunityAt)} · no product interactions in the current ${data.insights.windowDays}-day insight window.`
                : "Waiting for an eligible 2xx response on an included route or a selected MCP product-tool call."
            }
          />
          <ActivationMilestone
            complete={confirmedActivated}
            title="First confirmed interaction"
            detail={
              firstConfirmedInteractionAt
                ? confirmedCount
                  ? `First confirmed ${formatDate(firstConfirmedInteractionAt)} · ${confirmedCount} proven interaction(s) in the last ${data.insights.windowDays} days.`
                  : `First confirmed ${formatDate(firstConfirmedInteractionAt)} · no proven interactions in the current ${data.insights.windowDays}-day insight window.`
                : "MCP confirms a normal product-tool call immediately. HTTP confirms when a feedback capability returns with a report."
            }
          />
          <ActivationMilestone
            complete={reportActivated}
            title="First feedback report"
            detail={
              firstReportAt
                ? reportCount
                  ? `First received ${formatDate(firstReportAt)} · ${reportCount} structured report(s) in the last ${data.insights.windowDays} days.`
                  : `First received ${formatDate(firstReportAt)} · no reports in the current ${data.insights.windowDays}-day insight window.`
                : "Waiting for a feedback-aware agent to follow the current action. Ask modes require a real user decision; the doctor never impersonates one."
            }
          />
        </ol>
        {!opportunityActivated ? (
          <StatusMessage>
            Next: deploy the current write key, call the exact included route or tool, and check
            again. If it stays waiting, verify AGENT_FEEDBACK_ENABLED is not false, the include
            pattern matches, and the response is eligible.
          </StatusMessage>
        ) : !confirmedActivated ? (
          <StatusMessage>
            The company-side connection works. Next: exercise it with a feedback-aware customer
            agent. A generic HTTP client creates only an unconfirmed opportunity.
          </StatusMessage>
        ) : !reportActivated ? (
          <StatusMessage>
            Agent use is confirmed. Next: complete the returned feedback action; in an ask mode,
            approval must come from the user before a report is available.
          </StatusMessage>
        ) : (
          <StatusMessage>
            Activation complete: transport, agent-use evidence, and structured feedback are all
            visible for this product.
          </StatusMessage>
        )}
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
            <SecretCallout
              label="Save this read key now"
              secret={secrets.read}
              description="Put it in the MCP client's secret or environment facility. It can read this product's feedback but cannot instrument product traffic or submit reports."
              copy={copy}
            />
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
  description,
  copy,
}: {
  label: string;
  secret: string;
  description: string;
  copy: (value: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div>
        <strong>{label}</strong>
        <code className="mt-1 block break-all">{secret}</code>
        <small className="block max-w-3xl text-muted-foreground">
          This secret is shown only for this page load and cannot be recovered. {description}
        </small>
      </div>
      <Button type="button" variant="outline" onClick={() => void copy(secret)}>
        Copy key
      </Button>
    </div>
  );
}

function ActivationMilestone({
  complete,
  title,
  detail,
}: {
  complete: boolean;
  title: string;
  detail: string;
}) {
  return (
    <li className="flex gap-3 rounded-lg border p-3">
      <span aria-hidden="true" className="font-medium">
        {complete ? "✓" : "○"}
      </span>
      <span>
        <strong className="block">{title}</strong>
        <small className="text-muted-foreground">{detail}</small>
      </span>
    </li>
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
