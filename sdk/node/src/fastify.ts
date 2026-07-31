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
  shutdown(): Promise<void>;
};

export function agentFeedback(
  options: AgentFeedbackOptions<FastifyRequest>,
): AgentFeedbackFastifyPlugin {
  const runtime = new AgentFeedbackRuntime(options);
  const states = new WeakMap<object, RequestState>();

  const implementation = async (app: FastifyInstance) => {
    app.addHook("onRequest", (request, _reply, done) => {
      const context = runtime.context(request);
      const matched = runtime.matches(request.url);
      states.set(request, {
        started: performance.now(),
        context,
        consentState: matched ? runtime.cachedConsent(context.customerRef) : "unavailable",
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
        request.method === "HEAD" ||
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
      reply: { header(name: string, value: string): unknown },
      prepared: PreparedInteraction,
    ): void => {
      if (!prepared.envelope) return;
      reply.header("agent-feedback", encodedEnvelope(prepared.envelope));
      reply.header(
        "link",
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
      const contentType = String(reply.getHeader("content-type") || "");
      if (typeof payload === "string" && contentType.includes("text/html")) {
        const prepared = attach(request, reply, "http_html", payload)?.prepared;
        return prepared?.envelope ? injectHtml(payload, prepared.envelope) : payload;
      }
      const state = states.get(request);
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
  plugin.shutdown = () => runtime.shutdown();
  return plugin;
}

export default agentFeedback;
