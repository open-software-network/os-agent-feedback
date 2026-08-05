"use client";

import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { type ReactNode, useCallback, useEffect, useState } from "react";

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
import { cn } from "@/lib/utils";

import {
  LINKED_SESSION_VERIFICATION,
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
type SetupSectionId = "install" | "identify" | "personalize" | "verify";

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
}: {
  data: DashboardData;
  secrets: ShownSecrets | null;
  rememberSecret: (kind: "write" | "read", secret: string) => void;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
}) {
  const [surface, setSurface] = useState<SetupSurface>("experience");
  const [stack, setStack] = useState<SetupStack>("node-experience");
  const [identityExample, setIdentityExample] = useState<IdentityExample>("known");
  const [expandedSection, setExpandedSection] = useState<SetupSectionId | null>(
    () => setupSectionFromLocation() ?? "install",
  );
  const [error, setError] = useState("");
  const [creatingWriteKey, setCreatingWriteKey] = useState(false);
  const environment = data.currentEnvironment;
  const shownWriteSecret =
    secrets && environment && secrets.environmentId === environment.id ? secrets.write : undefined;
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
    ? "Customer answers are ready for personalization"
    : contextLearned
      ? "Customer answers received"
      : opportunityActivated
        ? "SDK connected"
        : "Not connected";
  const stacks = SETUP_SURFACES[surface].stacks as readonly SetupStack[];
  const environmentSnippet = `EPODE_API_KEY=${shownWriteSecret ?? "paste_product_key_here"}`;

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
    if (!stacks.includes(stack)) setStack(stacks[0]);
  }, [stack, stacks]);

  useEffect(() => {
    function syncSectionFromLocation() {
      const section = setupSectionFromLocation();
      setExpandedSection(section ?? "install");
      if (section) scrollSetupSectionIntoView(section);
    }

    const initialSection = setupSectionFromLocation();
    if (initialSection) scrollSetupSectionIntoView(initialSection);
    window.addEventListener("hashchange", syncSectionFromLocation);
    window.addEventListener("popstate", syncSectionFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncSectionFromLocation);
      window.removeEventListener("popstate", syncSectionFromLocation);
    };
  }, []);

  useEffect(() => {
    if (shownWriteSecret) {
      setExpandedSection("install");
      replaceSetupSectionHash("install");
    }
  }, [shownWriteSecret]);

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

  function toggleSection(section: SetupSectionId) {
    const opening = expandedSection !== section;
    setExpandedSection(opening ? section : null);
    if (opening) replaceSetupSectionHash(section);
    else if (setupSectionFromLocation() === section) replaceSetupSectionHash(null);
  }

  const legacyKey = writeKey && !/^af_(live|read)_[0-9a-f]{8}$/.test(writeKey.prefix);
  const contextSnippet = `const answers = await customer.context.get({
    userRef: req.user?.id,
    anonymousRef: req.user ? undefined : req.cookies.visitorId,
    purpose: "product_personalization",
});

const result = answers.available
  ? personalize(normalResult, answers.items)
  : normalResult;`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Setup"
        title={`Connect ${data.currentProduct.name}`}
        description={activationDescription}
      />
      <Metrics
        items={[
          { label: "Product key", value: writeKey ? "Ready" : "Missing" },
          { label: "SDK connected", value: opportunityActivated ? "Complete" : "Waiting" },
          { label: "Answers stored", value: contextLearned.toLocaleString() },
          { label: "Customers with context", value: customersWithContext.toLocaleString() },
          { label: "Ready customers", value: personalizationReady.toLocaleString() },
          { label: "Answer retrievals", value: contextRetrieved.toLocaleString() },
          { label: "Decisions", value: personalizationDecisions.toLocaleString() },
          { label: "Measured outcomes", value: personalizationOutcomes.toLocaleString() },
        ]}
      />
      <StatusMessage>
        Install Epode once to serve an agent experience graph and optional permissioned context. Your
        customers do not need an Epode account, app, plugin, or SDK.
      </StatusMessage>
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {legacyKey ? (
        <StatusMessage tone="error">
          This legacy key cannot create current Epode capabilities. Rotate it before installing.
        </StatusMessage>
      ) : null}

      <SetupSection
        id="install"
        title="1. Install Epode"
        expanded={expandedSection === "install"}
        onToggle={() => toggleSection("install")}
      >
        <p className="max-w-3xl text-sm text-muted-foreground">
          Start with the agent experience graph for negotiation and journey telemetry, or choose an
          enrichment surface. If Epode is unavailable, product responses stay fail-open.
        </p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SETUP_SURFACES) as SetupSurface[]).map((item) => (
            <Button
              key={item}
              type="button"
              variant={surface === item ? "default" : "outline"}
              aria-pressed={surface === item}
              onClick={() => {
                setSurface(item);
                setStack(SETUP_SURFACES[item].stacks[0] as SetupStack);
              }}
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
              aria-pressed={stack === item}
              onClick={() => setStack(item)}
            >
              {stackName(item)}
            </Button>
          ))}
        </div>
        {shownWriteSecret ? (
          <SecretCallout
            label="Save this server-side key now"
            secret={shownWriteSecret}
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
      </SetupSection>

      <SetupSection
        id="identify"
        title="2. Identify customers when possible"
        expanded={expandedSection === "identify"}
        onToggle={() => toggleSection("identify")}
      >
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
      </SetupSection>

      <SetupSection
        id="personalize"
        title="3. Use answers to personalize"
        expanded={expandedSection === "personalize"}
        onToggle={() => toggleSection("personalize")}
      >
        <p className="max-w-3xl text-sm text-muted-foreground">
          Retrieve approved answers from your server. Epode returns only relevant, permissioned, and
          unexpired information for the requested purpose.
        </p>
        <CodeBlock label="Server-side retrieval" value={contextSnippet} copy={copy} />
        <p className="text-sm text-muted-foreground">
          Use <code>product_personalization</code> for products, recommendations, content, and
          offers. <code>targeted_advertising</code> is separate and returns no items unless that use
          was explicitly approved.
        </p>
      </SetupSection>

      <SetupSection
        id="verify"
        title="4. Verify the complete loop"
        expanded={expandedSection === "verify"}
        onToggle={() => toggleSection("verify")}
      >
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
            title="Customer answers received"
            detail={
              contextLearned
                ? `${contextLearned} ${contextLearned === 1 ? "answer is" : "answers are"} available.`
                : "Use the product through a real customer agent and share approved answers."
            }
          />
          <ActivationMilestone
            complete={Boolean(contextRetrieved)}
            title="Answers retrieved"
            detail={
              contextRetrieved
                ? `${contextRetrieved} server-side ${contextRetrieved === 1 ? "retrieval has" : "retrievals have"} completed.`
                : "Retrieve approved answers from your server for product personalization."
            }
          />
        </ol>
        <StatusMessage>
          {!opportunityActivated
            ? "Next: deploy the product key and call an included route or tool."
            : !contextLearned
              ? "The company-side connection works. Next: complete one real customer-agent journey."
              : !contextRetrieved
                ? "Answers are ready. Retrieve them from your server and personalize the experience."
                : "Answer activation loop complete; linked Sessions still require the manual checks below."}
        </StatusMessage>
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium">
            Verify linked Sessions manually · not yet verified
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">{LINKED_SESSION_VERIFICATION}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            <li>
              Same Customer; Run A create, cache/dedup replay, and ordered follow-up appear in
              Session A.
            </li>
            <li>Run B and its ordered follow-up appear in a separate Session B, with no mixing.</li>
            <li>Missing or invalid ownership proof remains unlinked.</li>
            <li>Product calls survive an Epode outage.</li>
            <li>
              No plaintext typed identity or Session refs, arguments, prompts, results, credentials,
              or exceptions are stored or shown.
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Use Customers and Sessions for resolved linkage and ordered timelines, response records
            for unlinked evidence, the product client for outage behavior, and a
            persistence/dashboard audit for privacy. Current activation totals prove transport and
            answer milestones, not exact Session correlation.
          </p>
        </div>
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
      </SetupSection>

      <details className="rounded-lg border bg-background p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Advanced integration details
        </summary>
        <div className="mt-4 flex flex-col gap-5">
          <CodeBlock label="Coding-agent setup prompt" value={agentPrompt} copy={copy} />
          <p className="text-sm text-muted-foreground">
            Routes stay in code. Derive accountRef and userRef only from authenticated requests;
            anonymousRef must be a product-owned first-party ID. Add sessionRef only when your
            product already proves a journey belongs together.
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

function SetupSection({
  id,
  title,
  expanded,
  onToggle,
  children,
}: {
  id: SetupSectionId;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section id={`setup-${id}`} className="scroll-mt-4 border bg-background">
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`setup-${id}-content`}
          className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-base font-medium"
          onClick={onToggle}
        >
          <span>{title}</span>
          <IconChevronDownSmall
            aria-hidden="true"
            className={cn("shrink-0 transition-transform", expanded && "rotate-180")}
          />
        </button>
      </h2>
      {expanded ? (
        <div id={`setup-${id}-content`} className="flex flex-col gap-3 border-t p-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function setupSectionFromLocation(): SetupSectionId | null {
  if (typeof window === "undefined") return null;
  const section = window.location.hash.replace(/^#setup-/, "");
  return ["install", "identify", "personalize", "verify"].includes(section)
    ? (section as SetupSectionId)
    : null;
}

function replaceSetupSectionHash(section: SetupSectionId | null) {
  const url = new URL(window.location.href);
  url.hash = section ? `setup-${section}` : "";
  window.history.replaceState(window.history.state, "", url);
}

function scrollSetupSectionIntoView(section: SetupSectionId) {
  document.getElementById(`setup-${section}`)?.scrollIntoView?.({ block: "start" });
}

function identityDescription(identity: IdentityExample) {
  if (identity === "known") {
    return "Pass an opaque user or account reference from your existing authenticated request.";
  }
  if (identity === "anonymous") {
    return "Pass a stable first-party visitor reference from your own cookie or session.";
  }
  return "Pass no identity reference. Epode keeps answers bounded to the current interaction.";
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
// Epode keeps answers on this interaction handle; it does not create a durable customer profile.`;
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
        <span className="block font-medium">{title}</span>
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
