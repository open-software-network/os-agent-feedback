import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fastifyPlugin from "fastify-plugin";

import {
  type AgentFeedbackOptions,
  AgentFeedbackRuntime,
  encodedEnvelope,
  injectHtml,
  isPlainObject,
  normalizeOperation,
  type PreparedInteraction,
  type ProductSurface,
  requestDiscoveryLink,
} from "./core.js";

type RequestState = {
  started: number;
  prepared?: PreparedInteraction;
  instrumentationSkipped?: boolean;
  surface?: ProductSurface;
  operation?: string;
  context: { customerRef?: string; sessionRef?: string; runtimeHint?: string };
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

export function agentFeedback(
  options: AgentFeedbackOptions<FastifyRequest>,
): AgentFeedbackFastifyPlugin {
  const runtime = new AgentFeedbackRuntime(options);
  const states = new WeakMap<object, RequestState>();

  const implementation = async (app: FastifyInstance) => {
    app.addHook("onRequest", (request, _reply, done) => {
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
      },
      surface: ProductSurface,
      payload?: unknown,
    ): RequestState | undefined => {
      const state = states.get(request);
      if (!state) return undefined;
      if (state.instrumentationSkipped) return undefined;
      if (
        reply.statusCode < 200 ||
        reply.statusCode >= 300 ||
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
          cacheControl: String(reply.getHeader("cache-control") || ""),
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
      state.prepared = runtime.prepare({
        customerRef: state.context.customerRef,
        consentState: state.consentState,
      });
      state.surface = surface;
      state.operation = normalizeOperation(request.routeOptions?.url || request.url);
      reply.header("cache-control", "private, no-store");
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
        return prepared?.envelope ? { ...payload, _agentFeedback: prepared.envelope } : payload;
      }
      const state = attach(request, reply, "http_headers", payload);
      if (state?.prepared) headers(reply, state.prepared);
      return payload;
    });

    app.addHook("onSend", async (request, reply, payload) => {
      if (runtime.cacheMode === "request" && runtime.matches(request.url)) {
        ensureRequestVary(reply);
      }
      const contentType = String(reply.getHeader("content-type") || "");
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
        reply.statusCode >= 200 &&
        reply.statusCode < 300
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
        const prepared = attach(request, reply, "http_html", payload)?.prepared;
        return prepared?.envelope ? injectHtml(payload, prepared.envelope) : payload;
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
      if (
        !state?.prepared ||
        !state.surface ||
        !state.operation ||
        reply.statusCode < 200 ||
        reply.statusCode >= 300
      ) {
        return;
      }
      runtime.record(state.prepared, {
        surface: state.surface,
        operation: state.operation,
        statusCode: reply.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - state.started)),
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
