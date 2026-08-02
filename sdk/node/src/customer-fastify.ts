import { randomUUID } from "node:crypto";

import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { isPlainObject, matchPattern, normalizeOperation } from "./core.js";
import {
  type CustomerContext,
  type CustomerIdentity,
  type CustomerPurpose,
  createEpode,
  customerContextInteractionId,
  EPODE_CONTEXT_INTERACTION_HEADER,
  type EpodeClient,
  type EpodeClientOptions,
  injectCustomerContextHtml,
  sameOriginEnrichmentRequest,
} from "./customer.js";

export interface EpodeFastifyOptions extends EpodeClientOptions {
  include: string[];
  exclude?: string[];
  purpose?: CustomerPurpose;
  remember?: boolean;
  identify?: (request: FastifyRequest) => CustomerIdentity;
  /** Product-issued journey reference from authenticated/product state. */
  sessionRef?: (request: FastifyRequest) => string | undefined;
  /** Bounded runtime label observed or asserted by the product. */
  runtimeHint?: (request: FastifyRequest) => string | undefined;
  operation?: (request: FastifyRequest) => string | undefined;
  shouldRequest?: (request: FastifyRequest, body: Record<string, unknown>) => boolean;
  shouldRequestHtml?: (request: FastifyRequest, html: string) => boolean;
  /** Authentication for business routes. Exact Epode relay routes bypass it. */
  authenticate?: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;
  maxHtmlBytes?: number;
}

export type EpodeFastify = FastifyPluginCallback & {
  client: EpodeClient;
  context: EpodeClient["context"];
  personalization: EpodeClient["personalization"];
  outcomes: EpodeClient["outcomes"];
  interactionId(request: FastifyRequest): string | undefined;
  contextFor(request: FastifyRequest, purpose?: CustomerPurpose): Promise<CustomerContext>;
};

function pathOf(request: FastifyRequest): string {
  return request.url.split("?")[0] || "/";
}

function matches(request: FastifyRequest, options: EpodeFastifyOptions): boolean {
  const path = pathOf(request);
  if (path.startsWith("/_epode/")) return false;
  if (options.exclude?.some((pattern) => matchPattern(path, pattern))) return false;
  return options.include.some((pattern) => matchPattern(path, pattern));
}

function isRelay(request: FastifyRequest): boolean {
  const path = pathOf(request);
  return (
    request.method === "POST" &&
    (path === "/_epode/v1/enrichment/consent" || path === "/_epode/v1/enrichment/answers")
  );
}

function isHtml(reply: FastifyReply, payload: unknown): payload is string {
  return (
    typeof payload === "string" &&
    String(reply.getHeader("content-type") || "")
      .toLowerCase()
      .startsWith("text/html")
  );
}

function varyInteraction(reply: FastifyReply): void {
  const existingVary = reply.getHeader("vary");
  const varyValues = String(existingVary || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !varyValues.some(
      (value) => value.toLowerCase() === EPODE_CONTEXT_INTERACTION_HEADER.toLowerCase(),
    )
  ) {
    reply.header("vary", [...varyValues, EPODE_CONTEXT_INTERACTION_HEADER].join(", "));
  }
}

export function epode(options: EpodeFastifyOptions): EpodeFastify {
  if (!Array.isArray(options.include) || options.include.length === 0) {
    throw new Error("Epode Fastify requires at least one explicit include route");
  }
  const maxHtmlBytes = options.maxHtmlBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxHtmlBytes) || maxHtmlBytes < 1_024) {
    throw new Error("Epode Fastify maxHtmlBytes must be an integer of at least 1024");
  }
  const client = createEpode(options);
  const startedAt = new WeakMap<FastifyRequest, number>();
  const interactionId = (request: FastifyRequest) =>
    customerContextInteractionId(request.headers[EPODE_CONTEXT_INTERACTION_HEADER.toLowerCase()]);
  const identity = (request: FastifyRequest): CustomerIdentity => options.identify?.(request) || {};
  const implementation: FastifyPluginCallback = (app, _pluginOptions, done) => {
    app.addHook("onRequest", (request, _reply, next) => {
      startedAt.set(request, Date.now());
      next();
    });
    app.addHook("preHandler", async (request, reply) => {
      if (isRelay(request) || !matches(request, options)) return;
      await options.authenticate?.(request, reply);
    });
    const relay = async (
      request: FastifyRequest,
      reply: { code(status: number): unknown; header(name: string, value: string): unknown },
      path: string,
    ) => {
      const result = await client.relay({
        path,
        authorization:
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
        body: request.body,
      });
      reply.header("cache-control", "private, no-store");
      if (result.status === 503) reply.header("retry-after", "1");
      return (reply.code(result.status) as { send(body: unknown): unknown }).send(result.body);
    };

    app.post("/_epode/v1/enrichment/consent", (request, reply) =>
      relay(request, reply, "/_epode/v1/enrichment/consent"),
    );
    app.post("/_epode/v1/enrichment/answers", (request, reply) =>
      relay(request, reply, "/_epode/v1/enrichment/answers"),
    );

    app.addHook("preSerialization", async (request, reply, payload) => {
      const jsonPayload = isPlainObject(payload) && !Object.hasOwn(payload, "_epode");
      if (
        !matches(request, options) ||
        reply.statusCode < 200 ||
        reply.statusCode >= 300 ||
        reply.statusCode === 204 ||
        !jsonPayload
      ) {
        return payload;
      }
      varyInteraction(reply);
      if (options.shouldRequest) {
        try {
          if (!options.shouldRequest(request, payload)) return payload;
        } catch (error) {
          client.logger.warn(
            `[epode] shouldRequest failed; the original product response was preserved. ${String(error)}`,
          );
          return payload;
        }
      }
      let identity: CustomerIdentity = {};
      let sessionRef: string | undefined;
      let runtimeHint: string | undefined;
      try {
        identity = options.identify?.(request) || {};
        sessionRef = options.sessionRef?.(request);
        runtimeHint = options.runtimeHint?.(request);
      } catch (error) {
        client.logger.warn(
          `[epode] identity/session/runtime evidence failed; customer enrichment was skipped. ${String(error)}`,
        );
        return payload;
      }
      const stable = Boolean(
        identity.accountRef || identity.userRef || identity.anonymousRef || identity.customerRef,
      );
      const operation =
        options.operation?.(request)?.trim() || request.routeOptions?.url || pathOf(request);
      const enrichment = await client.enrichment.request({
        ...identity,
        interactionId: interactionId(request) || randomUUID(),
        operation: normalizeOperation(operation),
        surface: "http_json",
        statusCode: reply.statusCode,
        durationMs: Math.min(Date.now() - (startedAt.get(request) ?? Date.now()), 86_400_000),
        ...(sessionRef ? { sessionRef } : {}),
        ...(runtimeHint ? { runtimeHint } : {}),
        purpose: options.purpose || "product_personalization",
        remember: options.remember ?? stable,
      });
      if (!enrichment) return payload;
      reply.header("cache-control", "private, no-store");
      return {
        ...payload,
        _epode: { customerContext: sameOriginEnrichmentRequest(enrichment) },
      };
    });

    app.addHook("onSend", async (request, reply, payload) => {
      if (
        !matches(request, options) ||
        reply.statusCode < 200 ||
        reply.statusCode >= 300 ||
        reply.statusCode === 204 ||
        !isHtml(reply, payload)
      ) {
        return payload;
      }
      varyInteraction(reply);
      if (options.shouldRequestHtml) {
        try {
          if (!options.shouldRequestHtml(request, payload)) return payload;
        } catch (error) {
          client.logger.warn(
            `[epode] shouldRequestHtml failed; the original HTML was preserved. ${String(error)}`,
          );
          return payload;
        }
      }
      let resolvedIdentity: CustomerIdentity = {};
      let sessionRef: string | undefined;
      let runtimeHint: string | undefined;
      try {
        resolvedIdentity = options.identify?.(request) || {};
        sessionRef = options.sessionRef?.(request);
        runtimeHint = options.runtimeHint?.(request);
      } catch (error) {
        client.logger.warn(
          `[epode] identity/session/runtime evidence failed; customer enrichment was skipped. ${String(error)}`,
        );
        return payload;
      }
      const stable = Boolean(
        resolvedIdentity.accountRef ||
          resolvedIdentity.userRef ||
          resolvedIdentity.anonymousRef ||
          resolvedIdentity.customerRef,
      );
      const operation =
        options.operation?.(request)?.trim() || request.routeOptions?.url || pathOf(request);
      const enrichment = await client.enrichment.request({
        ...resolvedIdentity,
        interactionId: interactionId(request) || randomUUID(),
        operation: normalizeOperation(operation),
        surface: "html",
        statusCode: reply.statusCode,
        durationMs: Math.min(Date.now() - (startedAt.get(request) ?? Date.now()), 86_400_000),
        ...(sessionRef ? { sessionRef } : {}),
        ...(runtimeHint ? { runtimeHint } : {}),
        purpose: options.purpose || "product_personalization",
        remember: options.remember ?? stable,
      });
      if (!enrichment) return payload;
      const html = injectCustomerContextHtml(
        payload,
        sameOriginEnrichmentRequest(enrichment),
        maxHtmlBytes,
      );
      if (!html) {
        client.logger.warn(
          "[epode] HTML enrichment skipped because the document is oversized or already owns the Epode marker.",
        );
        return payload;
      }
      reply.header("cache-control", "private, no-store");
      for (const header of ["content-length", "content-md5", "etag"]) reply.removeHeader(header);
      return html;
    });
    done();
  };
  const plugin = fastifyPlugin(implementation, { name: "epode-customer-context" }) as EpodeFastify;
  plugin.client = client;
  plugin.context = client.context;
  plugin.personalization = client.personalization;
  plugin.outcomes = client.outcomes;
  plugin.interactionId = interactionId;
  plugin.contextFor = async (request, purpose = options.purpose || "product_personalization") => {
    try {
      const continued = interactionId(request);
      return await client.context.get({
        ...identity(request),
        ...(continued ? { interactionId: continued } : {}),
        purpose,
      });
    } catch (error) {
      client.logger.warn(
        `[epode] identify failed during context retrieval; the normal product experience should be used. ${String(error)}`,
      );
      return { available: false, identityLevel: "ephemeral", items: [] };
    }
  };
  return plugin;
}
