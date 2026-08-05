import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fastifyPlugin from "fastify-plugin";

import {
  type AgentFeedbackOptions,
  AgentFeedbackRuntime,
  encodedEnvelope,
  hasEmbeddedFeedback,
  injectHtml,
  isPlainObject,
  normalizeOperation,
  type PreparedInteraction,
  type ProductSurface,
  requestDiscoveryLink,
} from "./core.js";
import { EPODE_CONTEXT_INTERACTION_HEADER } from "./customer.js";
import {
  completeOperation,
  type OperationFacts,
  operationState,
  prepareSharedInteraction,
} from "./operation-state.js";

export type { EpodeFastify, EpodeFastifyOptions } from "./customer-fastify.js";
export { epode } from "./customer-fastify.js";

type RequestState = {
  started: number;
  prepared?: PreparedInteraction;
  facts?: OperationFacts;
  instrumentationSkipped?: boolean;
  context: {
    accountRef?: string;
    userRef?: string;
    anonymousRef?: string;
    customerRef?: string;
    sessionRef?: string;
    runtimeHint?: string;
  };
  consentState: Awaited<ReturnType<AgentFeedbackRuntime<FastifyRequest>["resolveConsent"]>>;
};

export type AgentFeedbackFastifyPlugin = FastifyPluginAsync & {
  /** Flush queued telemetry, for serverless waitUntil/lifecycle hooks. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

function ensureRequestVary(reply: {
  header(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}): void {
  const current = String(reply.getHeader("vary") || "");
  const tokens = current
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!tokens.some((value) => value.toLowerCase() === "agent-feedback-request")) {
    tokens.push("Agent-Feedback-Request");
  }
  reply.header("vary", tokens.join(", "));
}

function ensureInteractionVary(reply: {
  header(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}): void {
  const current = String(reply.getHeader("vary") || "");
  const tokens = current
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !tokens.some((value) => value.toLowerCase() === EPODE_CONTEXT_INTERACTION_HEADER.toLowerCase())
  ) {
    tokens.push(EPODE_CONTEXT_INTERACTION_HEADER);
  }
  reply.header("vary", tokens.join(", "));
}

function appendLink(
  reply: {
    header(name: string, value: string | string[]): unknown;
    getHeader(name: string): unknown;
  },
  value: string,
): void {
  const current = reply.getHeader("link");
  if (Array.isArray(current)) {
    reply.header("link", [...current.map(String), value]);
  } else if (current !== undefined) {
    reply.header("link", [String(current), value]);
  } else {
    reply.header("link", value);
  }
}

function isCompleteSuccess(reply: {
  statusCode: number;
  getHeader(name: string): unknown;
}): boolean {
  return (
    reply.statusCode >= 200 &&
    reply.statusCode < 300 &&
    reply.statusCode !== 204 &&
    reply.statusCode !== 205 &&
    reply.statusCode !== 206 &&
    reply.getHeader("content-range") === undefined
  );
}

function isStreamingOrBinary(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  if (Buffer.isBuffer(payload) || ArrayBuffer.isView(payload)) return true;
  const candidate = payload as {
    pipe?: unknown;
    getReader?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };
  return (
    typeof candidate.pipe === "function" ||
    typeof candidate.getReader === "function" ||
    typeof candidate[Symbol.asyncIterator] === "function"
  );
}

function stripBodyValidators(reply: { removeHeader(name: string): unknown }): void {
  for (const name of [
    "etag",
    "content-md5",
    "digest",
    "content-digest",
    "repr-digest",
    "content-range",
    "accept-ranges",
  ]) {
    reply.removeHeader(name);
  }
}

const CDN_CACHE_CONTROL_HEADERS = [
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "surrogate-control",
] as const;

function cacheControlValues(reply: { getHeader(name: string): unknown }): string[] {
  return ["cache-control", ...CDN_CACHE_CONTROL_HEADERS]
    .map((name) => reply.getHeader(name))
    .filter((value) => value !== undefined)
    .map(String);
}

function makeResponsePrivate(reply: {
  header(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}): void {
  for (const name of CDN_CACHE_CONTROL_HEADERS) reply.removeHeader(name);
  reply.header("cache-control", "private, no-store");
}

export function agentFeedback(
  options: AgentFeedbackOptions<FastifyRequest>,
): AgentFeedbackFastifyPlugin {
  const runtime = new AgentFeedbackRuntime(options);
  const states = new WeakMap<object, RequestState>();

  const implementation = async (app: FastifyInstance) => {
    app.addHook("onRequest", (request, _reply, done) => {
      operationState(request, request.headers[EPODE_CONTEXT_INTERACTION_HEADER.toLowerCase()]);
      states.set(request, {
        started: performance.now(),
        context: {},
        consentState: "unavailable",
      });
      done();
    });

    const attach = (
      request: FastifyRequest,
      reply: {
        statusCode: number;
        header(name: string, value: string): unknown;
        getHeader(name: string): unknown;
        removeHeader(name: string): unknown;
      },
      surface: ProductSurface,
      payload?: unknown,
    ): RequestState | undefined => {
      const state = states.get(request);
      if (!state) return undefined;
      if (state.instrumentationSkipped) return undefined;
      if (
        !isCompleteSuccess(reply) ||
        (request.method === "HEAD" && surface !== "http_headers") ||
        !runtime.matches(request.url)
      ) {
        return undefined;
      }
      if (state.prepared) return state;
      if (
        !runtime.shouldInstrumentHttp({
          request,
          surface: surface as Exclude<ProductSurface, "mcp">,
          statusCode: reply.statusCode,
          body: payload,
          requestOptIn: request.headers["agent-feedback-request"] === "1",
          cacheControls: cacheControlValues(reply),
        })
      ) {
        return undefined;
      }
      // Authentication commonly runs in preValidation or preHandler. Read
      // customer/session context only after the handler has completed so a
      // global Epode plugin sees the verified identity established by normal
      // Fastify authentication hooks.
      state.context = runtime.context(request);
      state.consentState = runtime.cachedConsent(state.context.customerRef);
      const completed = completeOperation(request, {
        surface,
        operation: normalizeOperation(request.routeOptions?.url || request.url),
        statusCode: reply.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - state.started)),
      });
      if (completed.conflict) {
        state.instrumentationSkipped = true;
        runtime.logger.warn(
          "[agent-feedback] Conflicting operation completion; feedback was skipped.",
        );
        return undefined;
      }
      state.prepared = prepareSharedInteraction(
        runtime,
        {
          customerRef: state.context.customerRef,
          consentState: state.consentState,
        },
        completed.facts.interactionId,
      );
      state.facts = completed.facts;
      ensureInteractionVary(reply);
      makeResponsePrivate(reply);
      return state;
    };

    const headers = (
      reply: {
        header(name: string, value: string | string[]): unknown;
        getHeader(name: string): unknown;
      },
      prepared: PreparedInteraction,
    ): void => {
      if (!prepared.envelope) return;
      reply.header("agent-feedback", encodedEnvelope(prepared.envelope));
      appendLink(
        reply,
        `<${runtime.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"`,
      );
    };

    app.addHook("preSerialization", async (request, reply, payload) => {
      if (isStreamingOrBinary(payload)) return payload;
      if (isPlainObject(payload)) {
        if (Object.hasOwn(payload, "_agentFeedback")) {
          const state = states.get(request);
          if (state) state.instrumentationSkipped = true;
          runtime.logger.warn(
            "[agent-feedback] Response already contains _agentFeedback; instrumentation was skipped.",
          );
          return payload;
        }
        const prepared = attach(request, reply, "http_json", payload)?.prepared;
        if (prepared?.envelope) stripBodyValidators(reply);
        return prepared?.envelope ? { ...payload, _agentFeedback: prepared.envelope } : payload;
      }
      // Strings need to reach onSend so HTML can receive its embedded handoff.
      // Scalar JSON still falls back to a header there.
      if (typeof payload === "string") return payload;
      const state = attach(request, reply, "http_headers", payload);
      if (state?.prepared) headers(reply, state.prepared);
      return payload;
    });

    app.addHook("onSend", async (request, reply, payload) => {
      if (runtime.cacheMode === "request" && runtime.matches(request.url)) {
        ensureRequestVary(reply);
      }
      if (isStreamingOrBinary(payload)) return payload;
      const contentType = String(reply.getHeader("content-type") || "").toLowerCase();
      const supported =
        contentType.includes("application/json") || contentType.includes("text/html");
      const optedIn = request.headers["agent-feedback-request"] === "1";
      const state = states.get(request);
      if (
        runtime.cacheMode === "request" &&
        !optedIn &&
        !state?.instrumentationSkipped &&
        supported &&
        (request.method === "GET" || request.method === "HEAD") &&
        isCompleteSuccess(reply)
      ) {
        const link = requestDiscoveryLink(request.raw.url || request.url);
        if (link) appendLink(reply, link);
      }
      if (request.method === "HEAD" && supported) {
        const headState = attach(request, reply, "http_headers", payload);
        if (headState?.prepared) headers(reply, headState.prepared);
        return payload;
      }
      if (typeof payload === "string" && contentType.includes("text/html")) {
        const surface = hasEmbeddedFeedback(payload) ? "http_headers" : "http_html";
        const state = attach(request, reply, surface, payload);
        if (!state?.prepared?.envelope) return payload;
        if (surface === "http_headers") {
          headers(reply, state.prepared);
          return payload;
        }
        stripBodyValidators(reply);
        return injectHtml(payload, state.prepared.envelope);
      }
      if (
        !state?.prepared &&
        !state?.instrumentationSkipped &&
        contentType.includes("application/json")
      ) {
        const state = attach(request, reply, "http_headers", payload);
        if (state?.prepared) headers(reply, state.prepared);
      }
      return payload;
    });

    app.addHook("onResponse", async (request, reply) => {
      const state = states.get(request);
      if (!state?.prepared || !state.facts || !isCompleteSuccess(reply)) {
        return;
      }
      runtime.record(state.prepared, {
        surface: state.facts.surface,
        operation: state.facts.operation,
        statusCode: state.facts.statusCode,
        durationMs: state.facts.durationMs,
        accountRef: state.context.accountRef,
        userRef: state.context.userRef,
        anonymousRef: state.context.anonymousRef,
        customerRef: state.context.customerRef,
        classification: "unclassified",
        runtimeHint: state.context.runtimeHint,
        runtimeHintSource: state.context.runtimeHint ? "http" : undefined,
        sessionRef: state.context.sessionRef,
        sessionSource: state.context.sessionRef ? "customer" : undefined,
      });
      runtime.warmConsent(state.context.customerRef);
    });

    app.addHook("onClose", async () => runtime.shutdown());
  };
  const plugin = fastifyPlugin(implementation, {
    name: "agent-feedback",
    fastify: ">=4 <6",
  }) as unknown as AgentFeedbackFastifyPlugin;
  plugin.flush = () => runtime.flush();
  plugin.shutdown = () => runtime.shutdown();
  return plugin;
}

export default agentFeedback;
