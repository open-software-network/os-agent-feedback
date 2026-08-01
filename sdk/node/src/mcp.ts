import { z } from "zod";

import {
  type AgentFeedbackOptions,
  AgentFeedbackRuntime,
  isPlainObject,
  matchPattern,
} from "./core.js";

type McpContext = Record<string, unknown>;
type McpResult = {
  content?: Record<string, unknown>[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
};

export interface McpInstrumentationOptions
  extends Omit<
    AgentFeedbackOptions<McpContext>,
    | "customerRef"
    | "sessionRef"
    | "runtimeHint"
    | "include"
    | "exclude"
    | "cacheMode"
    | "shouldInstrument"
  > {
  customerRef?: (
    arguments_: unknown,
    context: McpContext,
    result?: McpResult,
  ) => string | undefined | null;
  sessionRef?: (
    arguments_: unknown,
    context: McpContext,
    result?: McpResult,
  ) => string | undefined | null;
  runtimeHint?: (
    arguments_: unknown,
    context: McpContext,
    result?: McpResult,
  ) => string | undefined | null;
  /** Tool-name patterns to retain as confirmed interactions. Defaults to every business tool. */
  includeTools?: string[];
  /** Tool-name patterns to omit from both telemetry and feedback. */
  excludeTools?: string[];
  /**
   * Tool-name patterns that may receive feedback instructions. Calls outside
   * this subset remain visible in Sessions without asking for micro-feedback.
   * Defaults to every included tool; an empty array disables feedback requests.
   */
  feedbackTools?: string[];
  /** Background report-tool request timeout. Product tool calls are never coupled to it. */
  reportTimeoutMs?: number;
  /** Decide from the completed tool result whether this call is an outcome boundary. */
  shouldRequestFeedback?: (input: {
    name: string;
    arguments: unknown;
    context: McpContext;
    result: McpResult;
  }) => boolean;
}

type McpServer = { registerTool: (...arguments_: unknown[]) => unknown };

type FailureGuidance = { retryable: boolean; text: string };

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function consentFailureGuidance(status: number): FailureGuidance {
  if (isTransientHttpStatus(status)) {
    return {
      retryable: true,
      text: "Retry this permission action exactly once with the same arguments; never assume approval.",
    };
  }
  if (status === 401) {
    return {
      retryable: false,
      text: "The consent handle is invalid or expired; do not retry with the same handle. Do not assume approval.",
    };
  }
  if (status === 409) {
    return {
      retryable: false,
      text: "Consent is not applicable to the product's current mode. Do not retry; never assume approval.",
    };
  }
  if (status === 410) {
    return {
      retryable: false,
      text: "Feedback collection is disabled. Do not retry; never assume approval.",
    };
  }
  if (status === 404) {
    return {
      retryable: false,
      text: "The consent endpoint is unavailable for this integration. Do not retry; never assume approval.",
    };
  }
  return { retryable: false, text: "Do not retry. Do not assume approval." };
}

function reportFailureGuidance(status: number): FailureGuidance {
  if (status === 400 || status === 422) {
    return {
      retryable: true,
      text: "Retry this tool exactly once with only feedbackHandle and a concise summary; omit every optional field.",
    };
  }
  if (isTransientHttpStatus(status)) {
    return {
      retryable: true,
      text: "Retry this tool exactly once with the same arguments.",
    };
  }
  if (status === 401) {
    return {
      retryable: false,
      text: "The feedback handle is invalid or expired; do not retry with the same handle.",
    };
  }
  if (status === 403) {
    return {
      retryable: false,
      text: "Consent is required or was declined; do not retry. Never call this tool unless a feedback_ready action returned it.",
    };
  }
  if (status === 409) {
    return {
      retryable: false,
      text: "The feedback handle belongs to a different product environment. Do not retry.",
    };
  }
  if (status === 410) {
    return { retryable: false, text: "Feedback collection is disabled. Do not retry." };
  }
  if (status === 404) {
    return {
      retryable: false,
      text: "The feedback endpoint is unavailable for this integration. Do not retry.",
    };
  }
  return { retryable: false, text: "Do not retry with the same handle." };
}

export interface McpInstrumentation {
  instrument(server: McpServer): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

function matchesTool(
  name: string,
  include: string[] | undefined,
  exclude: string[] | undefined,
): boolean {
  if (exclude?.some((pattern) => matchPattern(name, pattern))) return false;
  return include === undefined || include.some((pattern) => matchPattern(name, pattern));
}

function instrumentServer(
  server: McpServer,
  runtime: AgentFeedbackRuntime<McpContext>,
  options: McpInstrumentationOptions,
): void {
  const originalRegister = server.registerTool.bind(server);

  server.registerTool = ((
    name: string,
    configuration: Record<string, unknown>,
    handler: (arguments_: unknown, context: McpContext) => Promise<McpResult> | McpResult,
  ) => {
    if (name === "report_product_feedback" || name === "record_product_feedback_consent") {
      return originalRegister(name, configuration, handler);
    }
    return originalRegister(
      name,
      configuration,
      async (arguments_: unknown, context: McpContext = {}) => {
        const started = performance.now();
        const contextValue = (
          callback:
            | ((
                arguments_: unknown,
                context: McpContext,
                result?: McpResult,
              ) => string | undefined | null)
            | undefined,
          completedResult?: McpResult,
        ): string | undefined => {
          try {
            return callback?.(arguments_, context, completedResult)?.trim() || undefined;
          } catch (error) {
            runtime.logger.warn(`[agent-feedback] MCP extractor failed: ${String(error)}`);
            return undefined;
          }
        };
        const observed = matchesTool(name, options.includeTools, options.excludeTools);
        let result: McpResult;
        try {
          result = await handler(arguments_, context);
        } catch (error) {
          if (runtime.enabled && observed) {
            const sessionRef = contextValue(options.sessionRef);
            const customerRef = contextValue(options.customerRef);
            const runtimeHint = contextValue(options.runtimeHint);
            const prepared = runtime.prepare({ customerRef, consentState: "unavailable" });
            runtime.record(prepared, {
              surface: "mcp",
              operation: name,
              statusCode: 500,
              durationMs: Math.max(0, Math.round(performance.now() - started)),
              classification: "confirmed",
              confirmationMethod: "mcp",
              customerRef,
              runtimeHint,
              runtimeHintSource: runtimeHint ? "mcp" : undefined,
              sessionRef,
              sessionSource: sessionRef ? "mcp" : undefined,
            });
          }
          throw error;
        }
        if (!runtime.enabled || !observed) return result;
        // MCP transport sessions are not product-session proof. Only an
        // explicit application-level extractor may group interactions.
        const sessionRef = contextValue(options.sessionRef, result);
        const customerRef = contextValue(options.customerRef, result);
        const runtimeHint = contextValue(options.runtimeHint, result);
        const feedbackTool =
          options.feedbackTools === undefined ||
          matchesTool(name, options.feedbackTools, undefined);
        let shouldRequestFeedback = feedbackTool;
        if (shouldRequestFeedback && options.shouldRequestFeedback) {
          try {
            shouldRequestFeedback = options.shouldRequestFeedback({
              name,
              arguments: arguments_,
              context,
              result,
            });
          } catch (error) {
            runtime.logger.warn(
              `[agent-feedback] MCP shouldRequestFeedback failed; feedback instructions were skipped. ${String(error)}`,
            );
            shouldRequestFeedback = false;
          }
        }
        // Match HTTP: only process-local consent state may influence the
        // product response. A remote lookup warms the cache in the background
        // after an eligible outcome, so Epode latency/outages never delay a
        // business tool result.
        const consentState = shouldRequestFeedback
          ? runtime.cachedConsent(customerRef)
          : "unavailable";
        const prepared = runtime.prepare({ customerRef, consentState });
        runtime.record(prepared, {
          surface: "mcp",
          operation: name,
          statusCode: result.isError ? 500 : 200,
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          classification: "confirmed",
          confirmationMethod: "mcp",
          customerRef,
          runtimeHint,
          runtimeHintSource: runtimeHint ? "mcp" : undefined,
          sessionRef,
          sessionSource: sessionRef ? "mcp" : undefined,
        });
        if (!shouldRequestFeedback) return result;
        // Unlike a generic HTTP error, an MCP isError result is an explicit,
        // agent-readable product outcome. Keep its confirmed failure telemetry
        // and allow the agent to report the bounded friction or gap.
        runtime.warmConsent(customerRef);

        const envelope = prepared.envelope;
        if (!envelope) return result;
        const consentAction = envelope.requiredAction?.submitDecision;
        const submit = envelope.submit;

        const feedback = {
          v: 1,
          mode: envelope.mode,
          ...(envelope.configuredMode ? { configuredMode: envelope.configuredMode } : {}),
          state: envelope.state,
          required: envelope.state === "feedback_ready",
          consentRequired: envelope.consentRequired,
          consentPolicy: envelope.consentPolicy,
          ...(envelope.consentManagedBy ? { consentManagedBy: envelope.consentManagedBy } : {}),
          reliability: "protocol_tool",
          when: envelope.when,
          instruction: envelope.instruction,
          ...(consentAction
            ? {
                consentTool: "record_product_feedback_consent",
                feedbackHandle: consentAction.authorization.replace(/^Bearer\s+/, ""),
                question: envelope.requiredAction?.question,
                decisionSchema: consentAction.bodySchema,
              }
            : {}),
          ...(submit
            ? {
                reportTool: "report_product_feedback",
                feedbackHandle: submit.authorization.replace(/^Bearer\s+/, ""),
                reportSchema: submit.reportSchema,
              }
            : {}),
          privacy: envelope.privacy,
          expiresAt: envelope.expiresAt,
        };
        const structuredContent = isPlainObject(result.structuredContent)
          ? { ...result.structuredContent, _agentFeedback: feedback }
          : { _agentFeedback: feedback };
        const content = Array.isArray(result.content) ? [...result.content] : [];
        content.push({
          type: "text",
          text: consentAction
            ? `${envelope.instruction} Then call record_product_feedback_consent with feedbackHandle ${feedback.feedbackHandle} and only the user's approved or declined decision. Do not call report_product_feedback unless that tool returns a feedback action.`
            : `${envelope.instruction} Call report_product_feedback with feedbackHandle ${feedback.feedbackHandle}, a concise summary, and any applicable findings.`,
        });
        return { ...result, structuredContent, content };
      },
    );
  }) as typeof server.registerTool;

  originalRegister(
    "record_product_feedback_consent",
    {
      title: "Record product feedback permission",
      description:
        "After asking the exact question returned by a product tool, record only the user's explicit approved or declined answer. Never infer approval from silence. Epode returns a separate report action only after approval.",
      inputSchema: z.object({
        feedbackHandle: z.string().startsWith("afr2_"),
        decision: z.enum(["approved", "declined"]),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({
      feedbackHandle,
      decision,
    }: {
      feedbackHandle: string;
      decision: "approved" | "declined";
    }) => {
      try {
        const response = await (options.fetch || globalThis.fetch)(
          `${runtime.endpoint}/api/v2/consent/decisions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${feedbackHandle}`,
              "content-type": "application/json",
              "user-agent": "@agent-feedback/node/0.2.1",
            },
            body: JSON.stringify({ decision }),
            signal: AbortSignal.timeout(options.reportTimeoutMs ?? 10_000),
          },
        );
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          const guidance = consentFailureGuidance(response.status);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Permission could not be recorded (HTTP ${response.status}). ${guidance.text}`,
              },
            ],
            structuredContent: { accepted: false, retryable: guidance.retryable },
          };
        }
        const returnedFeedback = isPlainObject(body.feedback) ? body.feedback : undefined;
        const returnedSubmit =
          returnedFeedback && isPlainObject(returnedFeedback.submit)
            ? returnedFeedback.submit
            : undefined;
        const returnedAuthorization =
          typeof returnedSubmit?.authorization === "string"
            ? returnedSubmit.authorization.replace(/^Bearer\s+/, "")
            : undefined;
        return {
          content: [
            {
              type: "text",
              text:
                decision === "approved" && returnedAuthorization
                  ? `Permission approved. Now autonomously call report_product_feedback with feedbackHandle ${returnedAuthorization}, a concise summary, and any applicable findings. Do not ask again.`
                  : "Permission declined. Do not submit product feedback.",
            },
          ],
          structuredContent: {
            ...body,
            ...(returnedAuthorization
              ? { reportTool: "report_product_feedback", feedbackHandle: returnedAuthorization }
              : {}),
          },
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Epode is temporarily unavailable. Retry this permission action exactly once with the same arguments; never assume approval.",
            },
          ],
          structuredContent: { accepted: false, retryable: true },
        };
      }
    },
  );

  originalRegister(
    "report_product_feedback",
    {
      title: "Report product feedback",
      description:
        "Submit one structured feedback report only when the product result or permission tool returned this report action. Describe the contribution and applicable findings without forcing a success/failure verdict. Never include prompts, transcripts, credentials, personal data, or raw product content.",
      inputSchema: z.object({
        feedbackHandle: z.string().startsWith("afr2_"),
        summary: z.string().min(8).max(700),
        impact: z
          .enum(["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"])
          .optional(),
        confidence: z.number().min(0).max(1).optional(),
        findings: z
          .array(
            z.object({
              kind: z.enum([
                "strength",
                "friction",
                "defect",
                "gap",
                "suggestion",
                "uncertainty",
                "other",
              ]),
              topic: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
              severity: z.enum(["minor", "major", "blocking"]).optional(),
              detail: z.string().min(3).max(350),
            }),
          )
          .max(8)
          .optional(),
        workaround: z
          .object({
            used: z.boolean(),
            detail: z.string().min(3).max(350).optional(),
          })
          .refine((value) => !value.used || Boolean(value.detail), {
            message: "detail is required when a workaround was used",
          })
          .optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({
      feedbackHandle,
      summary,
      impact,
      confidence,
      findings,
      workaround,
    }: {
      feedbackHandle: string;
      summary: string;
      impact?: string;
      confidence?: number;
      findings?: Array<{ kind: string; topic: string; severity?: string; detail: string }>;
      workaround?: { used: boolean; detail?: string };
    }) => {
      try {
        const response = await (options.fetch || globalThis.fetch)(
          `${runtime.endpoint}/api/v2/reports`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${feedbackHandle}`,
              "content-type": "application/json",
              "user-agent": "@agent-feedback/node/0.2.1",
            },
            body: JSON.stringify({
              summary,
              impact,
              confidence,
              findings,
              workaround,
            }),
            signal: AbortSignal.timeout(options.reportTimeoutMs ?? 10_000),
          },
        );
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          const guidance = reportFailureGuidance(response.status);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Feedback submission failed with HTTP ${response.status}. ${guidance.text}`,
              },
            ],
            structuredContent: { accepted: false, retryable: guidance.retryable },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: "Product feedback accepted. Keep this routine background success out of the final answer unless the user explicitly asked about feedback.",
            },
          ],
          structuredContent: body,
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Agent Feedback is temporarily unavailable. Retry this tool exactly once with the same arguments.",
            },
          ],
          structuredContent: { accepted: false, retryable: true },
        };
      }
    },
  );
}

/**
 * Creates one process-level MCP instrumentation runtime. Use this with the
 * stateless 2026-07-28 MCP server factory so telemetry can still be batched
 * across otherwise independent requests.
 */
export function createMcpInstrumentation(options: McpInstrumentationOptions): McpInstrumentation {
  const runtime = new AgentFeedbackRuntime<McpContext>({
    apiKey: options.apiKey,
    endpoint: options.endpoint,
    feedbackMode: options.feedbackMode,
    logger: options.logger,
    flushIntervalMs: options.flushIntervalMs,
    maxQueueSize: options.maxQueueSize,
    telemetryTimeoutMs: options.telemetryTimeoutMs,
    consentTimeoutMs: options.consentTimeoutMs,
    consentCacheTtlMs: options.consentCacheTtlMs,
    maxTelemetryAttempts: options.maxTelemetryAttempts,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    fetch: options.fetch,
  });
  return {
    instrument(server) {
      instrumentServer(server, runtime, options);
    },
    flush: () => runtime.flush(),
    shutdown: () => runtime.shutdown(),
  };
}

/**
 * Convenience API for a long-lived or legacy MCP server instance. New
 * stateless servers should use createMcpInstrumentation() once and call
 * feedback.instrument(server) inside their per-request server factory.
 */
export function instrumentMcp(
  server: McpServer,
  options: McpInstrumentationOptions,
): { shutdown(): Promise<void> } {
  const instrumentation = createMcpInstrumentation(options);
  instrumentation.instrument(server);
  return { shutdown: () => instrumentation.shutdown() };
}
