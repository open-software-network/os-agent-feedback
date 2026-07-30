import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fastifyPlugin from "fastify-plugin";

import {
  AgentFeedbackRuntime,
  encodedEnvelope,
  injectHtml,
  isPlainObject,
  normalizeOperation,
  type AgentFeedbackOptions,
  type PreparedInteraction,
  type ProductSurface,
} from "./core.js";

type RequestState = {
  started: number;
  prepared?: PreparedInteraction;
  surface?: ProductSurface;
  operation?: string;
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
    app.addHook("onRequest", async (request) => {
      states.set(request, { started: performance.now() });
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
      if (state.prepared) return state;
      if (
        reply.statusCode < 200 ||
        reply.statusCode >= 300 ||
        request.method === "HEAD" ||
        !runtime.matches(request.url)
      ) {
        return undefined;
      }
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
      state.prepared = runtime.prepare();
      state.surface = surface;
      state.operation = normalizeOperation(request.routeOptions?.url || request.url);
      reply.header("cache-control", "private, no-store");
      return state;
    };

    const headers = (
      reply: { header(name: string, value: string): unknown },
      prepared: PreparedInteraction,
    ): void => {
      reply.header("agent-feedback", encodedEnvelope(prepared.envelope));
      reply.header(
        "link",
        `<${runtime.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"`,
      );
    };

    app.addHook("preSerialization", async (request, reply, payload) => {
      if (isPlainObject(payload)) {
        if (Object.hasOwn(payload, "_agentFeedback")) {
          runtime.logger.warn(
            "[agent-feedback] Response already contains _agentFeedback; instrumentation was skipped.",
          );
          return payload;
        }
        const state = attach(request, reply, "http_json", payload);
        return state?.prepared
          ? { ...payload, _agentFeedback: state.prepared.envelope }
          : payload;
      }
      const state = attach(request, reply, "http_headers", payload);
      if (state?.prepared) headers(reply, state.prepared);
      return payload;
    });

    app.addHook("onSend", async (request, reply, payload) => {
      const contentType = String(reply.getHeader("content-type") || "");
      if (typeof payload === "string" && contentType.includes("text/html")) {
        const state = attach(request, reply, "http_html", payload);
        return state?.prepared
          ? injectHtml(payload, state.prepared.envelope)
          : payload;
      }
      if (!states.get(request)?.prepared && contentType.includes("application/json")) {
        const state = attach(request, reply, "http_headers", payload);
        if (state?.prepared) headers(reply, state.prepared);
      }
      return payload;
    });

    app.addHook("onResponse", async (request, reply) => {
      const state = states.get(request);
      if (!state?.prepared || !state.surface || !state.operation) return;
      const context = runtime.context(request);
      runtime.record(state.prepared, {
        surface: state.surface,
        operation: state.operation,
        statusCode: reply.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - state.started)),
        customerRef: context.customerRef,
        classification: "unclassified",
        runtimeHint: context.runtimeHint,
        runtimeHintSource: context.runtimeHint ? "http" : undefined,
        sessionRef: context.sessionRef,
        sessionSource: context.sessionRef ? "customer" : undefined,
      });
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
