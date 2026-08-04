import { Buffer } from "node:buffer";

const DEFAULT_ENDPOINT = "https://app.epode.ai";
const USER_AGENT = "@epode/node/0.4.0";
export const EPODE_CONTEXT_INTERACTION_HEADER = "Epode-Context-Interaction";
export const EPODE_CUSTOMER_CONTEXT_META = "epode-customer-context";

export type CustomerPurpose = "product_personalization" | "targeted_advertising";
export type CustomerIdentityLevel = "verified" | "pseudonymous" | "ephemeral";
export type CustomerSignalType = "intent" | "preference" | "constraint" | "interest";
export type CustomerSignalProvenance =
  | "agent_reports_user_statement"
  | "agent_reports_current_task"
  | "agent_inference";

export interface CustomerIdentity {
  accountRef?: string;
  userRef?: string;
  anonymousRef?: string;
  customerRef?: string;
}

export interface EpodeClientOptions {
  /** Defaults to EPODE_API_KEY. AGENT_FEEDBACK_KEY remains a temporary compatibility fallback. */
  apiKey?: string;
  /** Defaults to EPODE_API_URL or https://app.epode.ai. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  /** Company-side context latency budget. Defaults to 250 ms and always fails open. */
  timeoutMs?: number;
  /** Agent relay latency budget. Defaults to 5 seconds and never gates the product response. */
  relayTimeoutMs?: number;
  logger?: Pick<Console, "debug" | "warn">;
}

export interface EnrichmentRequestInput extends CustomerIdentity {
  interactionId: string;
  operation: string;
  surface: "http_json" | "html" | "mcp";
  statusCode?: number;
  durationMs?: number;
  /** Product-issued journey reference. Never accept this from model/tool arguments. */
  sessionRef?: string;
  /** Bounded, non-sensitive runtime label observed or asserted by the product. */
  runtimeHint?: string;
  purpose: CustomerPurpose;
  remember: boolean;
}

export interface AgentAction {
  url: string;
  method: "POST";
  authorization: string;
  contentType: "application/json";
  bodySchema: Record<string, unknown>;
}

export interface EnrichmentRequest {
  requestId: string;
  interactionId: string;
  state: "consent_required" | "answer_ready" | "declined" | "answered" | "no_relevant_context";
  purpose: CustomerPurpose;
  identityLevel: CustomerIdentityLevel;
  stageInstruction: string;
  question: string | null;
  answerInstruction: string | null;
  expiresAt: string;
  consent: AgentAction | null;
  submit: AgentAction | null;
}

export interface EphemeralContinuation {
  header: typeof EPODE_CONTEXT_INTERACTION_HEADER;
  value: string;
  expiresAt: string;
  instruction: string;
}

export interface AgentEnrichmentRequest extends Omit<EnrichmentRequest, "consent" | "submit"> {
  consent: AgentAction | null;
  submit: AgentAction | null;
  continuation: EphemeralContinuation | null;
}

export interface CustomerAnswerItem {
  key: string;
  type: CustomerSignalType;
  value: string;
  /** Optional legacy input. Epode discards it and generates a canonical catalog summary. */
  summary?: string;
  provenance: CustomerSignalProvenance;
  confidence?: number;
  remember: boolean;
  expiresAt?: string;
}

export interface CustomerAnswerInput {
  status: "answered" | "declined" | "no_relevant_context";
  items: CustomerAnswerItem[];
}

export interface AcceptedCustomerSignal extends CustomerAnswerItem {
  id?: string;
  signalId?: string;
}

export interface CustomerAnswerResult {
  accepted: boolean;
  requestId: string;
  interactionId: string;
  customerId?: string | null;
  signals: AcceptedCustomerSignal[];
}

export interface CustomerContextInput extends CustomerIdentity {
  interactionId?: string;
  purpose: CustomerPurpose;
}

export interface CustomerContextItem {
  signalId: string;
  key: string;
  type: CustomerSignalType;
  value: string;
  summary: string;
  provenance: CustomerSignalProvenance;
  confidence?: number | null;
  expiresAt?: string | null;
  allowedUses: CustomerPurpose[];
  remembered: boolean;
}

export interface AvailableCustomerContext {
  available: true;
  retrievalId: string;
  identityLevel: CustomerIdentityLevel;
  customerId?: string | null;
  interactionId?: string | null;
  contextVersion: string;
  items: CustomerContextItem[];
}

export interface UnavailableCustomerContext {
  available: false;
  identityLevel: "ephemeral";
  items: [];
}

export type CustomerContext = AvailableCustomerContext | UnavailableCustomerContext;

export interface PersonalizationDecisionInput {
  externalDecisionId: string;
  contextRetrievalId: string;
  signalIds: string[];
  variant?: string;
}

export interface PersonalizationDecision {
  id: string;
  externalDecisionId: string;
  purpose: CustomerPurpose;
  signalIds: string[];
  variant?: string | null;
  createdAt: string;
}

export type PersonalizationDecisionResult =
  | { recorded: true; decision: PersonalizationDecision }
  | { recorded: false };

export interface PersonalizationOutcomeInput {
  externalOutcomeId: string;
  decisionId: string;
  outcome: "conversion" | "completion" | "engagement" | "dismissal" | "abandonment";
  occurredAt?: string;
}

export interface PersonalizationOutcome extends PersonalizationOutcomeInput {
  id: string;
  occurredAt: string;
  createdAt: string;
}

export type PersonalizationOutcomeResult =
  | { recorded: true; outcome: PersonalizationOutcome }
  | { recorded: false };

export interface RelayRequest {
  path: string;
  authorization?: string;
  body: unknown;
}

export interface RelayResponse {
  status: number;
  body: unknown;
}

function endpoint(options: EpodeClientOptions): string {
  return (
    options.endpoint ||
    process.env.EPODE_API_URL ||
    process.env.AGENT_FEEDBACK_URL ||
    DEFAULT_ENDPOINT
  ).replace(/\/+$/, "");
}

function apiKey(options: EpodeClientOptions): string {
  const value = options.apiKey || process.env.EPODE_API_KEY || process.env.AGENT_FEEDBACK_KEY;
  if (!value) throw new Error("EPODE_API_KEY is required");
  if (!value.startsWith("af_live_"))
    throw new Error("EPODE_API_KEY must be a server-side product key");
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanIdentity(identity: CustomerIdentity): CustomerIdentity {
  const values: CustomerIdentity = {
    accountRef: identity.accountRef,
    userRef: identity.userRef,
    anonymousRef: identity.anonymousRef,
    customerRef: identity.customerRef,
  };
  const cleaned: CustomerIdentity = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    if (!validOpaque(value)) throw new Error(`${key} must be a bounded opaque company reference`);
    cleaned[key as keyof CustomerIdentity] = value;
  }
  return cleaned;
}

function safeDate(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validOpaque(value: unknown, maximum = 160): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("@") &&
    !/\s/.test(value) &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}

function validateConsentBody(
  value: unknown,
): value is { decision: "approved" | "declined"; remember?: boolean } {
  return (
    isPlainObject(value) &&
    exactKeys(value, ["decision", "remember"]) &&
    (value.decision === "approved" || value.decision === "declined") &&
    (value.remember === undefined || typeof value.remember === "boolean")
  );
}

function validateAnswerItem(value: unknown): value is CustomerAnswerItem {
  if (!isPlainObject(value)) return false;
  if (
    !exactKeys(value, [
      "key",
      "type",
      "value",
      "summary",
      "provenance",
      "confidence",
      "remember",
      "expiresAt",
    ]) ||
    typeof value.key !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value.key) ||
    !["intent", "preference", "constraint", "interest"].includes(String(value.type)) ||
    typeof value.value !== "string" ||
    value.value.length < 1 ||
    value.value.length > 160 ||
    (value.summary !== undefined &&
      (typeof value.summary !== "string" ||
        value.summary.length < 3 ||
        value.summary.length > 350)) ||
    !["agent_reports_user_statement", "agent_reports_current_task", "agent_inference"].includes(
      String(value.provenance),
    ) ||
    typeof value.remember !== "boolean" ||
    containsSensitiveText(value.value) ||
    (value.summary !== undefined && containsSensitiveText(value.summary))
  ) {
    return false;
  }
  if (
    value.confidence !== undefined &&
    (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1)
  ) {
    return false;
  }
  return (
    value.expiresAt === undefined ||
    (typeof value.expiresAt === "string" && safeDate(value.expiresAt))
  );
}

function containsSensitiveText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  return (
    value.includes("@") ||
    /\b(?:bearer\s+|password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|sk-[A-Za-z0-9])/i.test(
      value,
    ) ||
    hasControlCharacter
  );
}

function validateAnswerBody(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !exactKeys(value, ["status", "items"]) ||
    (value.items !== undefined && !Array.isArray(value.items))
  ) {
    return false;
  }
  if (!["answered", "declined", "no_relevant_context"].includes(String(value.status))) {
    return false;
  }
  const items = value.items || [];
  if (items.length > 8 || !items.every(validateAnswerItem)) return false;
  return value.status === "answered" ? items.length > 0 : items.length === 0;
}

function relayTarget(path: string): string | undefined {
  if (path === "/_epode/v1/enrichment/consent") {
    return "/api/v2/enrichment/consent/decisions";
  }
  if (path === "/_epode/v1/enrichment/answers") return "/api/v2/enrichment/answers";
  return undefined;
}

function agentHandle(authorization?: string): string | undefined {
  const match = /^Bearer (aqr1_[A-Za-z0-9._-]+)$/.exec(authorization || "");
  return match?.[1];
}

function actionWithSchema(
  action: AgentAction | null | undefined,
  path: "/_epode/v1/enrichment/consent" | "/_epode/v1/enrichment/answers",
): AgentAction | null {
  if (!action) return null;
  return {
    ...action,
    url: path,
  };
}

function sameOriginRelayBody(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const consent = isPlainObject(body.consent) ? (body.consent as unknown as AgentAction) : null;
  const submit = isPlainObject(body.submit) ? (body.submit as unknown as AgentAction) : null;
  return {
    ...body,
    ...(Object.hasOwn(body, "consent")
      ? { consent: actionWithSchema(consent, "/_epode/v1/enrichment/consent") }
      : {}),
    ...(Object.hasOwn(body, "submit")
      ? { submit: actionWithSchema(submit, "/_epode/v1/enrichment/answers") }
      : {}),
  };
}

export function customerContextInteractionId(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return undefined;
  const normalized = candidate.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized,
  )
    ? normalized
    : undefined;
}

/**
 * Injects a non-executable, CSP-safe base64url JSON marker into a bounded HTML string.
 * Returns undefined for oversized documents or pages that already own the marker.
 */
export function injectCustomerContextHtml(
  html: string,
  request: AgentEnrichmentRequest,
  maximumBytes = 512 * 1024,
): string | undefined {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1_024 ||
    Buffer.byteLength(html, "utf8") > maximumBytes ||
    html.toLowerCase().includes(`name="${EPODE_CUSTOMER_CONTEXT_META}"`)
  ) {
    return undefined;
  }
  const encoded = Buffer.from(
    JSON.stringify({ _epode: { customerContext: request } }),
    "utf8",
  ).toString("base64url");
  const marker = `<meta name="${EPODE_CUSTOMER_CONTEXT_META}" content="${encoded}">`;
  const head = /<\/head\s*>/i.exec(html);
  if (head?.index !== undefined) {
    return `${html.slice(0, head.index)}${marker}${html.slice(head.index)}`;
  }
  const body = /<\/body\s*>/i.exec(html);
  if (body?.index !== undefined) {
    return `${html.slice(0, body.index)}${marker}${html.slice(body.index)}`;
  }
  return `${html}${marker}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Epode returned a non-JSON response" };
  }
}

export class EpodeClient {
  readonly endpoint: string;
  readonly logger: Pick<Console, "debug" | "warn">;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #relayTimeoutMs: number;

  constructor(options: EpodeClientOptions = {}) {
    this.endpoint = endpoint(options);
    this.#apiKey = apiKey(options);
    this.#fetch = options.fetch || globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 250;
    this.#relayTimeoutMs = options.relayTimeoutMs ?? 5_000;
    this.logger = options.logger || console;
  }

  readonly enrichment = {
    request: async (input: EnrichmentRequestInput): Promise<EnrichmentRequest | undefined> => {
      try {
        return await this.#companyPost<EnrichmentRequest>("/api/v2/enrichment/requests", {
          ...cleanIdentity(input),
          interactionId: input.interactionId,
          operation: input.operation,
          surface: input.surface,
          ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
          ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
          ...(input.runtimeHint ? { runtimeHint: input.runtimeHint } : {}),
          purpose: input.purpose,
          remember: input.remember,
        });
      } catch (error) {
        this.logger.warn(
          `[epode] Customer enrichment is temporarily unavailable; the product response was not affected. ${String(error)}`,
        );
        return undefined;
      }
    },
  };

  readonly context = {
    get: async (input: CustomerContextInput): Promise<CustomerContext> => {
      try {
        const result = await this.#companyPost<Omit<AvailableCustomerContext, "available">>(
          "/api/v2/customer-context",
          {
            ...cleanIdentity(input),
            ...(input.interactionId ? { interactionId: input.interactionId } : {}),
            purpose: input.purpose,
          },
        );
        return { available: true, ...result };
      } catch (error) {
        this.logger.warn(
          `[epode] Customer context is temporarily unavailable; use the normal product experience. ${String(error)}`,
        );
        return { available: false, identityLevel: "ephemeral", items: [] };
      }
    },
  };

  readonly personalization = {
    decide: async (input: PersonalizationDecisionInput): Promise<PersonalizationDecisionResult> => {
      try {
        return {
          recorded: true,
          ...(await this.#companyPost<{ decision: PersonalizationDecision }>(
            "/api/v2/personalization/decisions",
            input,
          )),
        };
      } catch (error) {
        this.logger.warn(
          `[epode] Personalization decision was not recorded; the product experience may continue. ${String(error)}`,
        );
        return { recorded: false };
      }
    },
  };

  readonly outcomes = {
    track: async (input: PersonalizationOutcomeInput): Promise<PersonalizationOutcomeResult> => {
      try {
        return {
          recorded: true,
          ...(await this.#companyPost<{ outcome: PersonalizationOutcome }>(
            "/api/v2/personalization/outcomes",
            input,
          )),
        };
      } catch (error) {
        this.logger.warn(
          `[epode] Personalization outcome was not recorded; the product response was not affected. ${String(error)}`,
        );
        return { recorded: false };
      }
    },
  };

  async relay(input: RelayRequest): Promise<RelayResponse> {
    const target = relayTarget(input.path);
    const handle = agentHandle(input.authorization);
    if (!target) return { status: 404, body: { error: "not_found" } };
    if (!handle) return { status: 401, body: { error: "invalid_customer_context_handle" } };
    const valid = target.endsWith("/decisions")
      ? validateConsentBody(input.body)
      : validateAnswerBody(input.body);
    if (!valid) return { status: 400, body: { error: "invalid_customer_context_body" } };
    try {
      const response = await this.#fetch(`${this.endpoint}${target}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${handle}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify(input.body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#relayTimeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        return { status: 502, body: { error: "epode_redirect_rejected" } };
      }
      return { status: response.status, body: sameOriginRelayBody(await responseBody(response)) };
    } catch {
      return {
        status: 503,
        body: { error: "customer_context_temporarily_unavailable", retryable: true },
      };
    }
  }

  async submitConsent(
    requestHandle: string,
    decision: "approved" | "declined",
    remember?: boolean,
  ): Promise<RelayResponse> {
    return this.relay({
      path: "/_epode/v1/enrichment/consent",
      authorization: `Bearer ${requestHandle}`,
      body: { decision, ...(remember === undefined ? {} : { remember }) },
    });
  }

  async inspectEnrichment(requestHandle: string): Promise<RelayResponse> {
    const handle = agentHandle(`Bearer ${requestHandle}`);
    if (!handle) return { status: 401, body: { error: "invalid_customer_context_handle" } };
    try {
      const response = await this.#fetch(`${this.endpoint}/api/v2/enrichment/requests/inspect`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${handle}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#relayTimeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        return { status: 502, body: { error: "epode_redirect_rejected" } };
      }
      return { status: response.status, body: sameOriginRelayBody(await responseBody(response)) };
    } catch {
      return {
        status: 503,
        body: { error: "customer_context_temporarily_unavailable", retryable: true },
      };
    }
  }

  async submitAnswer(requestHandle: string, answer: CustomerAnswerInput): Promise<RelayResponse> {
    return this.relay({
      path: "/_epode/v1/enrichment/answers",
      authorization: `Bearer ${requestHandle}`,
      body: answer,
    });
  }

  async #companyPost<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("redirect rejected");
    const parsed = await responseBody(response);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parsed as T;
  }
}

export function createEpode(options: EpodeClientOptions = {}): EpodeClient {
  return new EpodeClient(options);
}

export function sameOriginEnrichmentRequest(request: EnrichmentRequest): AgentEnrichmentRequest {
  return {
    requestId: request.requestId,
    interactionId: request.interactionId,
    state: request.state,
    purpose: request.purpose,
    identityLevel: request.identityLevel,
    stageInstruction: request.stageInstruction,
    question: request.question ?? null,
    answerInstruction: request.answerInstruction ?? null,
    expiresAt: request.expiresAt,
    consent: actionWithSchema(request.consent, "/_epode/v1/enrichment/consent"),
    submit: actionWithSchema(request.submit, "/_epode/v1/enrichment/answers"),
    continuation:
      request.identityLevel === "ephemeral"
        ? {
            header: EPODE_CONTEXT_INTERACTION_HEADER,
            value: request.interactionId,
            expiresAt: request.expiresAt,
            instruction: `For the immediate retry of this same product operation only, send the request header ${EPODE_CONTEXT_INTERACTION_HEADER}: ${request.interactionId}. Do not reuse it for another product or task.`,
          }
        : null,
  };
}

export const customerContextRelayPaths = [
  "/_epode/v1/enrichment/consent",
  "/_epode/v1/enrichment/answers",
] as const;
