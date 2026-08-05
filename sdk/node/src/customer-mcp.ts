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
  type RelayResponse,
  sameOriginEnrichmentRequest,
} from "./customer.js";
import {
  beginOperation,
  completeOperation,
  endOperation,
  operationTimer,
} from "./operation-state.js";

export type EpodeMcpContext = Record<string, unknown> & {
  http?: { authInfo?: { extra?: Record<string, unknown> } };
  mcpReq?: {
    envelope?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
  };
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

const EPODE_CONTROL_TOOLS = new Set([
  "report_product_feedback",
  "record_product_feedback_consent",
  "record_customer_context_consent",
  "share_customer_context",
]);

export interface EpodeMcpOptions extends EpodeClientOptions {
  includeTools: string[];
  excludeTools?: string[];
  /**
   * Customer-context fields the product may request after a successful tool
   * call. Either a static key list or a planner that reads company state and
   * returns the missing field keys for this operation. An empty array skips
   * enrichment for the call; a thrown planner error preserves the original
   * result and skips enrichment. Keys are validated server-side against the
   * product's field catalog and operation bindings.
   */
  fields?:
    | string[]
    | ((input: {
        name: string;
        arguments: unknown;
        context: EpodeMcpContext;
        result: McpResult;
      }) => string[] | undefined | Promise<string[] | undefined>);
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

function permissionChoice(request: EnrichmentRequest) {
  return {
    mode: "form" as const,
    message:
      request.question ||
      "Choose whether this product may use relevant, non-sensitive context to personalize your experience.",
    requestedSchema: {
      type: "object" as const,
      properties: {
        choice: {
          type: "string" as const,
          title: "Optional personalization",
          description:
            "Choose whether this product may use relevant preferences, interests, intent, and constraints shared through your assistant.",
          oneOf: [
            { const: "always_allow", title: "Always allow" },
            { const: "this_session_only", title: "This session only" },
            { const: "dont_allow", title: "Don't allow" },
          ],
        },
      },
      required: ["choice"],
    },
  };
}

function supportsFormElicitation(context: EpodeMcpContext): boolean {
  const envelope = context.mcpReq?.envelope;
  // Older SDK hosts do not expose the negotiated envelope on handler context.
  // Let their MCP serving layer perform its normal capability projection.
  if (envelope === undefined) return true;
  const capabilities = envelope["io.modelcontextprotocol/clientCapabilities"];
  if (!isPlainObject(capabilities)) return false;
  const elicitation = capabilities.elicitation;
  if (!isPlainObject(elicitation)) return false;
  // A bare declaration is the pre-mode spelling of form support. Once a
  // client names a mode, form must be named explicitly.
  return elicitation.form !== undefined || elicitation.url === undefined;
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
          answerTool: "share_customer_context",
          requestHandle: handle(request.consent),
          permissionMode: "best_effort_mcp_elicitation",
          answerSchema: schema.submit?.bodySchema,
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
  const instruction =
    request.state === "consent_required"
      ? "After finishing the product task, call share_customer_context once with only relevant, non-sensitive context. When the MCP client supports resumable form elicitation, the tool will present the company's optional-personalization choice inline. Otherwise it will share nothing; do not ask the user separately in chat."
      : [request.stageInstruction, request.answerInstruction].filter(Boolean).join(" ");
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
        if (EPODE_CONTROL_TOOLS.has(name)) {
          return originalRegister(name, configuration, handler);
        }
        const invoke = async (
          arguments_: unknown,
          context: EpodeMcpContext,
          business: () => Promise<McpResult> | McpResult,
        ): Promise<McpResult> => {
          const durationMs = operationTimer();
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
          let fieldKeys: string[] | undefined;
          if (options.fields !== undefined) {
            try {
              fieldKeys =
                typeof options.fields === "function"
                  ? await options.fields({ name, arguments: arguments_, context, result })
                  : options.fields;
            } catch (error) {
              client.logger.warn(
                `[epode] MCP field planner failed; the original tool result was preserved and enrichment was skipped. ${String(error)}`,
              );
              return result;
            }
            if (fieldKeys !== undefined) {
              if (
                !Array.isArray(fieldKeys) ||
                fieldKeys.some((key) => typeof key !== "string" || key.trim().length === 0)
              ) {
                client.logger.warn(
                  "[epode] MCP field planner returned invalid keys; the original tool result was preserved and enrichment was skipped.",
                );
                return result;
              }
              if (fieldKeys.length === 0) return result;
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
          const completed = completeOperation(context, {
            surface: "mcp",
            operation: name,
            statusCode: 200,
            durationMs: durationMs(),
          });
          if (completed.conflict) {
            client.logger.warn(
              "[epode] Conflicting operation completion; optional enrichment was skipped.",
            );
            return result;
          }
          const request = await client.enrichment.request({
            ...identity,
            interactionId: completed.facts.interactionId,
            operation: completed.facts.operation,
            ...(fieldKeys?.length ? { fieldKeys } : {}),
            surface: "mcp",
            statusCode: completed.facts.statusCode,
            durationMs: completed.facts.durationMs,
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
            ? async (context: EpodeMcpContext) => {
                beginOperation(context);
                try {
                  return await invoke({}, context, () =>
                    (handler as McpHandlerWithoutInput)(context),
                  );
                } finally {
                  endOperation(context);
                }
              }
            : async (arguments_: unknown, context: EpodeMcpContext) => {
                beginOperation(context);
                try {
                  return await invoke(arguments_, context, () =>
                    (handler as McpHandlerWithInput)(arguments_, context),
                  );
                } finally {
                  endOperation(context);
                }
              };
        return originalRegister(name, configuration, instrumented);
      }) as RegisterTool;

      originalRegister(
        "record_customer_context_consent",
        {
          title: "Record customer-context permission (explicit compatibility)",
          description:
            "Explicit compatibility or profile-settings use only after the product integration separately obtained the customer's data-use choice. Never call automatically and never infer permission.",
          inputSchema: z.object({
            requestHandle: z.string().startsWith("aqr1_"),
            decision: z.enum(["approved", "declined"]),
            remember: z.boolean().optional(),
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({
          requestHandle,
          decision,
          remember,
        }: {
          requestHandle: string;
          decision: "approved" | "declined";
          remember?: boolean;
        }) => {
          const response = await client.submitConsent(requestHandle, decision, remember);
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
          title: "Share customer context",
          description:
            "Share up to eight relevant, non-sensitive context items. When a data-use choice is needed, this tool presents it once inside the MCP client, records the answer, and continues in the same call. Distinguish explicit statements, current-task context, and inference.",
          inputSchema: z.object({
            requestHandle: z.string().startsWith("aqr1_"),
            status: z.enum(["answered", "no_relevant_context", "answer_skipped"]),
            items: z
              .array(
                z.object({
                  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
                  type: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
                  value: z.string().min(1).max(160),
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
        async (
          { requestHandle, ...answer }: CustomerAnswerInput & { requestHandle: string },
          context: EpodeMcpContext,
        ) => {
          const inspection = await client.inspectEnrichment(requestHandle);
          const inspected = isPlainObject(inspection.body)
            ? (inspection.body as unknown as EnrichmentRequest)
            : undefined;
          if (inspection.status >= 400 || !inspected) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "The customer-context request could not be verified. Do not share context.",
                },
              ],
              structuredContent: isPlainObject(inspection.body) ? inspection.body : {},
            };
          }
          let response: RelayResponse;
          if (inspected.state === "consent_required") {
            const inputResponse = context.mcpReq?.inputResponses?.customer_context_permission;
            if (inputResponse === undefined) {
              if (!context.mcpReq || !supportsFormElicitation(context)) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Optional personalization is unavailable in this MCP client. Continue the product task without sharing customer context, and do not ask the user separately in chat.",
                    },
                  ],
                  structuredContent: {
                    accepted: false,
                    state: "unsupported",
                    reason: "form_elicitation_unavailable",
                  },
                };
              }
              return {
                resultType: "input_required",
                inputRequests: {
                  customer_context_permission: {
                    method: "elicitation/create",
                    params: permissionChoice(inspected),
                  },
                },
              };
            }
            if (!isPlainObject(inputResponse)) {
              return {
                isError: true,
                content: [{ type: "text", text: "The personalization response was invalid." }],
              };
            }
            const action = inputResponse.action;
            if (action !== "accept" && action !== "decline" && action !== "cancel") {
              return {
                isError: true,
                content: [{ type: "text", text: "The personalization response was invalid." }],
              };
            }
            if (action === "cancel") {
              return {
                content: [
                  {
                    type: "text",
                    text: "The customer dismissed optional personalization. Continue without sharing context.",
                  },
                ],
                structuredContent: { accepted: false, state: "canceled" },
              };
            }
            const content = isPlainObject(inputResponse.content) ? inputResponse.content : {};
            const selected = action === "accept" ? content.choice : "dont_allow";
            if (selected === "dont_allow" || action === "decline") {
              const declined = await client.submitConsent(requestHandle, "declined");
              return {
                isError: declined.status >= 400,
                content: [
                  {
                    type: "text",
                    text: "The customer chose not to allow personalization. Continue without sharing context.",
                  },
                ],
                structuredContent: isPlainObject(declined.body)
                  ? declined.body
                  : { accepted: false, state: "consent_declined" },
              };
            }
            if (selected !== "always_allow" && selected !== "this_session_only") {
              return {
                isError: true,
                content: [{ type: "text", text: "The personalization choice was invalid." }],
              };
            }
            const remember = selected === "always_allow";
            const approved = await client.submitConsent(requestHandle, "approved", remember);
            const approvedBody = isPlainObject(approved.body) ? approved.body : {};
            const submit = isPlainObject(approvedBody.submit)
              ? (approvedBody.submit as unknown as { authorization: string })
              : undefined;
            const nextHandle = handle(submit);
            if (approved.status >= 400 || !nextHandle) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "The customer's personalization choice could not be recorded.",
                  },
                ],
                structuredContent: approvedBody,
              };
            }
            const permittedAnswer = remember
              ? answer
              : { ...answer, items: answer.items.map((item) => ({ ...item, remember: false })) };
            response = await client.submitAnswer(nextHandle, permittedAnswer);
          } else if (inspected.state === "consent_declined" || inspected.state === "declined") {
            return {
              content: [
                {
                  type: "text",
                  text: "No customer context will be shared for this request. Continue the product task.",
                },
              ],
              structuredContent: { accepted: false, state: "consent_declined" },
            };
          } else if (
            inspected.state === "answered" ||
            inspected.state === "no_relevant_context" ||
            inspected.state === "answer_skipped"
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: "Customer context was already handled for this request. Continue the product task.",
                },
              ],
              structuredContent: {
                accepted: true,
                state: inspected.state,
                alreadyCompleted: true,
              },
            };
          } else {
            response = await client.submitAnswer(requestHandle, answer);
          }
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
