import { randomUUID } from "node:crypto";

import { z } from "zod";
import { isPlainObject, matchPattern } from "./core.js";
import {
  type CustomerAnswerInput,
  type CustomerIdentity,
  type CustomerPurpose,
  createEpode,
  type EnrichmentRequest,
  type EpodeClient,
  type EpodeClientOptions,
  sameOriginEnrichmentRequest,
} from "./customer.js";

export type EpodeMcpContext = Record<string, unknown> & {
  http?: { authInfo?: { extra?: Record<string, unknown> } };
};

type McpResult = {
  content?: Record<string, unknown>[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

type McpHandlerWithoutInput = (context: EpodeMcpContext) => Promise<McpResult> | McpResult;
type McpHandlerWithInput = (
  arguments_: unknown,
  context: EpodeMcpContext,
) => Promise<McpResult> | McpResult;
type RegisterTool = (
  name: string,
  configuration: Record<string, unknown>,
  handler: (...arguments_: never[]) => unknown,
) => unknown;
type McpServer = { registerTool: (...arguments_: never[]) => unknown };

export interface EpodeMcpOptions extends EpodeClientOptions {
  includeTools: string[];
  excludeTools?: string[];
  purpose?: CustomerPurpose;
  remember?: boolean;
  identify?: (arguments_: unknown, context: EpodeMcpContext, result: McpResult) => CustomerIdentity;
  /** Product-issued journey reference. It receives context only, never model/tool arguments. */
  sessionRef?: (context: EpodeMcpContext) => string | undefined;
  /** Static or context-derived bounded runtime label. It never receives model/tool arguments. */
  runtimeHint?: string | ((context: EpodeMcpContext) => string | undefined);
  shouldRequest?: (input: {
    name: string;
    arguments: unknown;
    context: EpodeMcpContext;
    result: McpResult;
  }) => boolean;
}

export interface EpodeMcp {
  client: EpodeClient;
  context: EpodeClient["context"];
  personalization: EpodeClient["personalization"];
  outcomes: EpodeClient["outcomes"];
  instrument(server: McpServer): void;
}

function included(name: string, options: EpodeMcpOptions): boolean {
  if (options.excludeTools?.some((pattern) => matchPattern(name, pattern))) return false;
  return options.includeTools.some((pattern) => matchPattern(name, pattern));
}

function isCompleteSuccess(result: McpResult): boolean {
  if (result.isError === true) return false;
  const state = String(result.resultType ?? result.status ?? "").toLowerCase();
  return !["input_required", "canceled", "cancelled", "incomplete"].includes(state);
}

function handle(action?: { authorization: string }): string | undefined {
  return action?.authorization.replace(/^Bearer\s+/, "");
}

function mcpContract(request: EnrichmentRequest): Record<string, unknown> {
  const schema = sameOriginEnrichmentRequest(request);
  return {
    requestId: request.requestId,
    interactionId: request.interactionId,
    state: request.state,
    purpose: request.purpose,
    identityLevel: request.identityLevel,
    stageInstruction: request.stageInstruction,
    expiresAt: request.expiresAt,
    ...(request.question ? { question: request.question } : {}),
    ...(request.answerInstruction ? { answerInstruction: request.answerInstruction } : {}),
    ...(request.state === "consent_required" && request.consent
      ? {
          consentTool: "record_customer_context_consent",
          requestHandle: handle(request.consent),
          decisionSchema: schema.consent?.bodySchema,
        }
      : {}),
    ...(request.consent
      ? {
          manageConsent: {
            consentTool: "record_customer_context_consent",
            requestHandle: handle(request.consent),
          },
        }
      : {}),
    ...(request.submit
      ? {
          answerTool: "share_customer_context",
          requestHandle: handle(request.submit),
          answerSchema: schema.submit?.bodySchema,
        }
      : {}),
  };
}

function attach(result: McpResult, request: EnrichmentRequest, schemaOwned: boolean): McpResult {
  const contract = mcpContract(request);
  const instruction = [request.stageInstruction, request.answerInstruction]
    .filter(Boolean)
    .join(" ");
  const content = Array.isArray(result.content) ? [...result.content] : [];
  if (
    schemaOwned ||
    (result.structuredContent !== undefined && !isPlainObject(result.structuredContent))
  ) {
    content.push({ type: "text", text: JSON.stringify({ _epode: { customerContext: contract } }) });
  }
  content.push({ type: "text", text: instruction });
  if (schemaOwned) return { ...result, content };
  return {
    ...result,
    structuredContent: {
      ...(isPlainObject(result.structuredContent) ? result.structuredContent : {}),
      _epode: { customerContext: contract },
    },
    content,
  };
}

export function epode(options: EpodeMcpOptions): EpodeMcp {
  if (!Array.isArray(options.includeTools) || options.includeTools.length === 0) {
    throw new Error("Epode MCP requires at least one explicit includeTools pattern");
  }
  const client = createEpode(options);
  return {
    client,
    context: client.context,
    personalization: client.personalization,
    outcomes: client.outcomes,
    instrument(server: McpServer): void {
      const target = server as { registerTool?: unknown };
      if (typeof target.registerTool !== "function") {
        throw new TypeError("Epode MCP requires a server with registerTool()");
      }
      const originalRegister = (target.registerTool as RegisterTool).bind(server);
      target.registerTool = ((
        name: string,
        configuration: Record<string, unknown>,
        handler: McpHandlerWithoutInput | McpHandlerWithInput,
      ) => {
        if (name === "record_customer_context_consent" || name === "share_customer_context") {
          return originalRegister(name, configuration, handler);
        }
        const invoke = async (
          arguments_: unknown,
          context: EpodeMcpContext,
          business: () => Promise<McpResult> | McpResult,
        ): Promise<McpResult> => {
          const startedAt = Date.now();
          const result = await business();
          if (!isCompleteSuccess(result) || !included(name, options)) return result;
          if (options.shouldRequest) {
            try {
              if (!options.shouldRequest({ name, arguments: arguments_, context, result })) {
                return result;
              }
            } catch (error) {
              client.logger.warn(
                `[epode] MCP shouldRequest failed; the original tool result was preserved. ${String(error)}`,
              );
              return result;
            }
          }
          let identity: CustomerIdentity = {};
          let sessionRef: string | undefined;
          let runtimeHint: string | undefined;
          try {
            identity = options.identify?.(arguments_, context, result) || {};
            sessionRef = options.sessionRef?.(context);
            runtimeHint =
              typeof options.runtimeHint === "function"
                ? options.runtimeHint(context)
                : options.runtimeHint;
          } catch (error) {
            client.logger.warn(
              `[epode] MCP identity/session/runtime evidence failed; customer enrichment was skipped. ${String(error)}`,
            );
            return result;
          }
          const stable = Boolean(
            identity.accountRef ||
              identity.userRef ||
              identity.anonymousRef ||
              identity.customerRef,
          );
          const request = await client.enrichment.request({
            ...identity,
            interactionId: randomUUID(),
            operation: name,
            surface: "mcp",
            statusCode: 200,
            durationMs: Math.min(Date.now() - startedAt, 86_400_000),
            ...(sessionRef ? { sessionRef } : {}),
            ...(runtimeHint ? { runtimeHint } : {}),
            purpose: options.purpose || "product_personalization",
            remember: options.remember ?? stable,
          });
          return request
            ? attach(result, request, configuration.outputSchema !== undefined)
            : result;
        };
        const instrumented =
          configuration.inputSchema === undefined
            ? async (context: EpodeMcpContext) =>
                invoke({}, context, () => (handler as McpHandlerWithoutInput)(context))
            : async (arguments_: unknown, context: EpodeMcpContext) =>
                invoke(arguments_, context, () =>
                  (handler as McpHandlerWithInput)(arguments_, context),
                );
        return originalRegister(name, configuration, instrumented);
      }) as RegisterTool;

      originalRegister(
        "record_customer_context_consent",
        {
          title: "Record customer-context permission",
          description:
            "Record only the customer's explicit answer to the exact company question returned by a product tool. Never infer permission from silence or an ambiguous reply.",
          inputSchema: z.object({
            requestHandle: z.string().startsWith("aqr1_"),
            decision: z.enum(["approved", "declined"]),
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({
          requestHandle,
          decision,
        }: {
          requestHandle: string;
          decision: "approved" | "declined";
        }) => {
          const response = await client.submitConsent(requestHandle, decision);
          const body = isPlainObject(response.body) ? response.body : {};
          const submit = isPlainObject(body.submit)
            ? (body.submit as unknown as { authorization: string })
            : undefined;
          const nextHandle = handle(submit);
          return {
            isError: response.status >= 400,
            content: [
              {
                type: "text",
                text:
                  response.status >= 400
                    ? "Permission could not be recorded. Retry once only when retryable is true; never assume approval."
                    : nextHandle
                      ? `Permission recorded. Call share_customer_context once with requestHandle ${nextHandle}.`
                      : "Permission declined. Do not share customer context.",
              },
            ],
            structuredContent: {
              ...body,
              ...(nextHandle
                ? { answerTool: "share_customer_context", requestHandle: nextHandle }
                : {}),
            },
          };
        },
      );

      originalRegister(
        "share_customer_context",
        {
          title: "Share permitted customer context",
          description:
            "Share up to eight relevant, non-sensitive customer context items after the customer has granted the returned permission. Distinguish explicit statements, current-task context, and inference.",
          inputSchema: z.object({
            requestHandle: z.string().startsWith("aqr1_"),
            status: z.enum(["answered", "declined", "no_relevant_context"]),
            items: z
              .array(
                z.object({
                  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
                  type: z.enum(["intent", "preference", "constraint", "interest"]),
                  value: z.string().min(1).max(160),
                  summary: z.string().min(3).max(350),
                  provenance: z.enum([
                    "agent_reports_user_statement",
                    "agent_reports_current_task",
                    "agent_inference",
                  ]),
                  confidence: z.number().min(0).max(1).optional(),
                  remember: z.boolean(),
                  expiresAt: z.iso.datetime().optional(),
                }),
              )
              .max(8),
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({ requestHandle, ...answer }: CustomerAnswerInput & { requestHandle: string }) => {
          const response = await client.submitAnswer(requestHandle, answer);
          const body = isPlainObject(response.body) ? response.body : {};
          return {
            isError: response.status >= 400,
            content: [
              {
                type: "text",
                text:
                  response.status >= 400
                    ? "Customer context was not accepted. Retry once only when retryable is true."
                    : "Customer context was accepted. Continue the customer's product task without mentioning routine bookkeeping.",
              },
            ],
            structuredContent: body,
          };
        },
      );
    },
  };
}
