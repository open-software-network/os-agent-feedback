"use client";

import { useCallback, useEffect, useState } from "react";

import type { ShownSecrets } from "@/components/dashboard/types";
import { Metrics, PageHeader, Panel, StatusMessage } from "@/components/dashboard/view-primitives";
import { Button } from "@/components/ui/button";
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
  SETUP_SURFACES,
  type SetupStack,
  type SetupSurface,
  setupAgentPrompt,
  setupInstructions,
  stackName,
} from "./instructions";

const WRITE_KEY_ENSURE_PREFIX = "agent-feedback:write-key-ensured:";
const fallbackWriteKeyEnsureState = new Map<string, "pending" | "done">();

type IdentityExample = "known" | "anonymous" | "ephemeral";

type EnrichmentInsights = {
  customerContextItems: number;
  customersWithContext: number;
  contextRetrievals: number;
  personalizationReadyCustomers: number;
  personalizationDecisions: number;
  personalizationOutcomes: number;
};

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
  const [surface, setSurface] = useState<SetupSurface>("api");
  const [stack, setStack] = useState<SetupStack>("node-express");
  const [identityExample, setIdentityExample] = useState<IdentityExample>("known");
  const [error, setError] = useState("");
  const [creatingWriteKey, setCreatingWriteKey] = useState(false);
  const environment = data.currentEnvironment;
  const writeKeys = data.apiKeys.filter((key) => key.kind !== "read");
  const writeKey = writeKeys[0];
  const origin = typeof window === "undefined" ? "https://app.epode.ai" : window.location.origin;
  const integration = setupInstructions(stack, surface, origin);
  const agentPrompt = setupAgentPrompt(surface, stack, integration, origin);
  const editor = isEditor(data.currentRole);
  const opportunityActivated = Boolean(data.activationMilestones?.firstOpportunityAt);
  const insights = data.insights as typeof data.insights & Partial<EnrichmentInsights>;
  const contextLearned = insights.customerContextItems ?? 0;
  const customersWithContext = insights.customersWithContext ?? 0;
  const contextRetrieved = insights.contextRetrievals ?? 0;
  const personalizationReady = insights.personalizationReadyCustomers ?? 0;
  const personalizationDecisions = insights.personalizationDecisions ?? 0;
  const personalizationOutcomes = insights.personalizationOutcomes ?? 0;
  const activationDescription = contextRetrieved
    ? "Customer context is ready for personalization"
    : contextLearned
      ? "Customer context learned"
      : opportunityActivated
        ? "SDK connected"
        : "Not connected";
  const stacks = SETUP_SURFACES[surface].stacks as readonly SetupStack[];
  const environmentSnippet = `EPODE_API_KEY=${secrets?.write ?? "paste_product_key_here"}`;

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
      try {
        const created = await apiRequest<ApiKeyCreatedResponse>("/api/settings/api-keys", {
          method: "POST",
          workspaceId: data.workspace.id,
          body: JSON.stringify(input),
        });
        finishWriteKeyEnsure(environmentId);
        rememberSecret("write", created.secret);
        setNotice("Product key created. Save it now; it is shown once.");
        await refresh();
      } catch (caught) {
        releaseWriteKeyEnsure(environmentId);
        setError(caught instanceof Error ? caught.message : "Could not create product key");
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

  useEffect(() => {
    if (!stacks.includes(stack)) setStack(stacks[0]);
  }, [stack, stacks]);

  if (!environment || !data.currentProduct) return <Panel>No product is selected.</Panel>;
  if (!editor) return <Panel>Only a team owner or admin can manage setup.</Panel>;

  async function rotateKey(key: ApiKey) {
    if (!window.confirm(`Rotate ${key.label}? The old key will expire in one hour.`)) return;
    setError("");
    try {
      const rotated = await apiRequest<ApiKeyRotatedResponse>(
        `/api/settings/api-keys/${key.id}/rotate`,
        { method: "POST", workspaceId: data.workspace.id },
      );
      rememberSecret("write", rotated.secret);
      setNotice("Product key rotated. Update it within one hour.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rotate key");
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
  const contextSnippet = `const context = await customer.context.get({
    userRef: req.user?.id,
    anonymousRef: req.user ? undefined : req.cookies.visitorId,
    purpose: "product_personalization",
});

const result = context.available
  ? personalize(normalResult, context.items)
  : normalResult;`;

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
          { label: "Product key", value: writeKey ? "Ready" : "Preparing" },
          { label: "SDK connected", value: opportunityActivated ? "Complete" : "Waiting" },
          { label: "Context items", value: contextLearned.toLocaleString() },
          { label: "Customers with context", value: customersWithContext.toLocaleString() },
          { label: "Ready customers", value: personalizationReady.toLocaleString() },
          { label: "Context retrievals", value: contextRetrieved.toLocaleString() },
          { label: "Decisions", value: personalizationDecisions.toLocaleString() },
          { label: "Measured outcomes", value: personalizationOutcomes.toLocaleString() },
        ]}
      />
      <StatusMessage>
        Install Epode once in your company&apos;s product. Your customers do not need an Epode
        account, app, plugin, or SDK.
      </StatusMessage>
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {legacyKey ? (
        <StatusMessage tone="error">
          This legacy key cannot create current Epode capabilities. Rotate it before installing.
        </StatusMessage>
      ) : null}

      <Panel title="1. Install Epode">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Choose how customers&apos; agents reach your product, then add one server-side
          integration. If Epode is unavailable, the SDK preserves the normal product response.
        </p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SETUP_SURFACES) as SetupSurface[]).map((item) => (
            <Button
              key={item}
              type="button"
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
              type="button"
              size="sm"
              variant={stack === item ? "secondary" : "outline"}
              onClick={() => setStack(item)}
            >
              {stackName(item)}
            </Button>
          ))}
        </div>
        {secrets?.write ? (
          <SecretCallout
            label="Save this server-side key now"
            secret={secrets.write}
            description="Move it directly into your deployment secret manager. Never put it in browser code, a mobile app, or an agent client."
            copy={copy}
          />
        ) : writeKey ? (
          <p className="text-sm text-muted-foreground">
            Product key {writeKey.prefix}… is ready. Rotate it if the full value was not saved.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {creatingWriteKey ? "Preparing your product key…" : "No product key is active."}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={creatingWriteKey}
              onClick={() => void createWriteKey(true)}
            >
              Create product key
            </Button>
          </div>
        )}
        <CodeBlock label="Server environment" value={environmentSnippet} copy={copy} />
        <CodeBlock label="Install" value={integration.install} copy={copy} />
      </Panel>

      <Panel title="2. Identify customers when possible">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Use the identity your product already has. Known and anonymous customers are supported;
          requests without a stable reference remain interaction-only. Epode never tries to discover
          who a person is.
        </p>
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="Customer identity examples"
        >
          {(["known", "anonymous", "ephemeral"] as const).map((item) => (
            <Button
              key={item}
              type="button"
              size="sm"
              role="tab"
              aria-selected={identityExample === item}
              variant={identityExample === item ? "secondary" : "outline"}
              onClick={() => setIdentityExample(item)}
            >
              {identityExampleLabel(item)}
            </Button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{identityDescription(identityExample)}</p>
        <CodeBlock
          label={`${titleCase(identityExample)} customer`}
          value={identitySetupSnippet(identityExample)}
          copy={copy}
        />
        <CodeBlock label="Configure once" value={integration.code} copy={copy} />
      </Panel>

      <Panel title="3. Retrieve context and personalize">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Call the Context API from your server. Epode returns only relevant, permissioned, and
          unexpired items for the requested purpose.
        </p>
        <CodeBlock label="Server-side Context API" value={contextSnippet} copy={copy} />
        <p className="text-sm text-muted-foreground">
          Use <code>product_personalization</code> for products, recommendations, content, and
          offers. <code>targeted_advertising</code> is separate and returns no items unless that use
          was explicitly approved.
        </p>
      </Panel>

      <Panel title="4. Verify the complete loop">
        <ol className="flex flex-col gap-3">
          <ActivationMilestone
            complete={opportunityActivated}
            title="SDK connected"
            detail={
              data.activationMilestones?.firstOpportunityAt
                ? `First activity received ${formatDate(data.activationMilestones.firstOpportunityAt)}.`
                : "Deploy the integration, then use one included product route or tool."
            }
          />
          <ActivationMilestone
            complete={Boolean(contextLearned)}
            title="Customer context learned"
            detail={
              contextLearned
                ? `${contextLearned} context ${contextLearned === 1 ? "item is" : "items are"} available.`
                : "Use the product through a real customer agent and share permitted context."
            }
          />
          <ActivationMilestone
            complete={Boolean(contextRetrieved)}
            title="Customer context retrieved"
            detail={
              contextRetrieved
                ? `${contextRetrieved} server-side ${contextRetrieved === 1 ? "retrieval has" : "retrievals have"} completed.`
                : "Call POST /api/v2/customer-context from your server for product_personalization."
            }
          />
        </ol>
        <StatusMessage>
          {!opportunityActivated
            ? "Next: deploy the product key and call an included route or tool."
            : !contextLearned
              ? "The company-side connection works. Next: complete one real customer-agent journey."
              : !contextRetrieved
                ? "Context is ready. Retrieve it from your server and personalize the experience."
                : "Setup complete: Epode learned customer context and your product retrieved it."}
        </StatusMessage>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void refresh()}>
            Check now
          </Button>
          <a
            className="inline-flex h-8 items-center rounded-md border px-3 text-sm"
            href="https://docs.epode.ai"
            target="_blank"
            rel="noreferrer"
          >
            Read integration docs
          </a>
        </div>
      </Panel>

      <details className="rounded-lg border bg-background p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Advanced integration details
        </summary>
        <div className="mt-4 flex flex-col gap-5">
          <CodeBlock label="Coding-agent setup prompt" value={agentPrompt} copy={copy} />
          <p className="text-sm text-muted-foreground">
            Routes stay in code. Derive accountRef and userRef only from authenticated server
            context; anonymousRef must be a product-owned first-party ID. Add sessionRef only when
            your product already proves a journey belongs together.
          </p>
          <p className="text-sm">Verify the transport: {integration.verify}</p>
          <div className="divide-y rounded-lg border px-3">
            {writeKeys.map((key) => (
              <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{key.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {key.prefix}… · created {formatDate(key.createdAt)} ·{" "}
                    {key.lastUsedAt ? `last used ${formatDate(key.lastUsedAt)}` : "never used"}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => void rotateKey(key)}>
                  Rotate
                </Button>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

function identityDescription(identity: IdentityExample) {
  if (identity === "known") {
    return "Pass an opaque user or account reference from your existing authenticated server context.";
  }
  if (identity === "anonymous") {
    return "Pass a stable first-party visitor reference from your own cookie or session.";
  }
  return "Pass no identity reference. Epode keeps context bounded to the current interaction.";
}

function identityExampleLabel(identity: IdentityExample) {
  return identity === "ephemeral" ? "No stable ID" : titleCase(identity);
}

function identitySetupSnippet(identity: IdentityExample) {
  if (identity === "known") {
    return `accountRef: req => req.user?.accountId,
userRef: req => req.user?.id,`;
  }
  if (identity === "anonymous") {
    return `anonymousRef: req => req.cookies.visitorId, // first-party ID`;
  }
  return `// No customer reference required.
// Epode keeps context on this interaction handle; it does not create a durable customer profile.`;
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
      <div className="min-w-0">
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
      <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
        <code>{value}</code>
      </pre>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => void copy(value)}
      >
        Copy
      </Button>
    </div>
  );
}
