import { randomUUID } from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { isPlainObject, matchPattern, normalizeOperation } from "./core.js";
import {
  type AgentEnrichmentRequest,
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

export interface EpodeExpressOptions extends EpodeClientOptions {
  /** Explicit product routes on which Epode may request useful customer context. */
  include: string[];
  exclude?: string[];
  purpose?: CustomerPurpose;
  /** Ask permission to retain useful context for later interactions. Defaults to true for stable identities. */
  remember?: boolean;
  identify?: (request: Request) => CustomerIdentity;
  /** Product-issued journey reference from authenticated/product state. */
  sessionRef?: (request: Request) => string | undefined;
  /** Bounded runtime label observed or asserted by the product. */
  runtimeHint?: (request: Request) => string | undefined;
  operation?: (request: Request) => string | undefined;
  shouldRequest?: (request: Request, body: Record<string, unknown>) => boolean;
  shouldRequestHtml?: (request: Request, html: string) => boolean;
  /** Authentication for business routes. Exact Epode relay routes bypass it. */
  authenticate?: RequestHandler;
  /** Largest HTML string eligible for injection. Defaults to 512 KiB. */
  maxHtmlBytes?: number;
}

export type EpodeExpress = RequestHandler & {
  client: EpodeClient;
  context: EpodeClient["context"];
  personalization: EpodeClient["personalization"];
  outcomes: EpodeClient["outcomes"];
  /** Safely reads the bounded immediate-retry interaction header, when present. */
  interactionId(request: Request): string | undefined;
  /** Retrieves context for the request's company identity or bounded ephemeral continuation. */
  contextFor(request: Request, purpose?: CustomerPurpose): Promise<CustomerContext>;
};

function requestPath(request: Request): string {
  return (request.originalUrl || request.url).split("?")[0] || "/";
}

function matches(request: Request, options: EpodeExpressOptions): boolean {
  const path = requestPath(request);
  if (path.startsWith("/_epode/")) return false;
  if (options.exclude?.some((pattern) => matchPattern(path, pattern))) return false;
  return options.include.some((pattern) => matchPattern(path, pattern));
}

function routeOperation(request: Request, options: EpodeExpressOptions): string {
  const configured = options.operation?.(request)?.trim();
  if (configured) return normalizeOperation(configured);
  const route = request.route as { path?: string | string[] } | undefined;
  const routePath = Array.isArray(route?.path) ? route?.path[0] : route?.path;
  return normalizeOperation(`${request.baseUrl || ""}${routePath || request.path || "/"}`);
}

function setRelayResponse(response: Response, status: number, body: unknown): void {
  response.status(status);
  response.setHeader("Cache-Control", "private, no-store");
  if (status === 503) response.setHeader("Retry-After", "1");
  response.json(body);
}

function looksLikeHtml(response: Response, body: unknown): body is string {
  if (typeof body !== "string") return false;
  const contentType = String(response.getHeader("content-type") || "").toLowerCase();
  return (
    contentType.startsWith("text/html") ||
    /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(body)
  );
}

function prepareMutatedResponse(response: Response): void {
  response.setHeader("Cache-Control", "private, no-store");
  for (const header of ["Content-Length", "Content-MD5", "ETag"]) response.removeHeader(header);
}

/**
 * One company-side Express middleware. It mounts the same-origin agent relay,
 * asks Epode for a bounded enrichment request on selected successful JSON
 * responses, and leaves the original response untouched on any Epode failure.
 */
export function epode(options: EpodeExpressOptions): EpodeExpress {
  if (!Array.isArray(options.include) || options.include.length === 0) {
    throw new Error("Epode Express requires at least one explicit include route");
  }
  const maxHtmlBytes = options.maxHtmlBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxHtmlBytes) || maxHtmlBytes < 1_024) {
    throw new Error("Epode Express maxHtmlBytes must be an integer of at least 1024");
  }
  const client = createEpode(options);
  const interactionId = (request: Request) =>
    customerContextInteractionId(request.get(EPODE_CONTEXT_INTERACTION_HEADER));
  const identity = (request: Request): CustomerIdentity => options.identify?.(request) || {};
  const middleware = ((request: Request, response: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const path = requestPath(request);
    if (
      request.method === "POST" &&
      (path === "/_epode/v1/enrichment/consent" || path === "/_epode/v1/enrichment/answers")
    ) {
      void client
        .relay({
          path,
          authorization: request.get("authorization") || undefined,
          body: request.body,
        })
        .then((result) => setRelayResponse(response, result.status, result.body));
      return;
    }
    if (!matches(request, options)) {
      next();
      return;
    }

    const instrument = () => {
      response.vary(EPODE_CONTEXT_INTERACTION_HEADER);
      const originalJson = response.json.bind(response);
      const originalSend = response.send.bind(response);
      let sent = false;

      const resolveIdentity = (): CustomerIdentity | undefined => {
        try {
          return options.identify?.(request) || {};
        } catch (error) {
          client.logger.warn(
            `[epode] identify failed; customer enrichment was skipped. ${String(error)}`,
          );
          return undefined;
        }
      };

      const resolveEvidence = (): { sessionRef?: string; runtimeHint?: string } | undefined => {
        try {
          const sessionRef = options.sessionRef?.(request);
          const runtimeHint = options.runtimeHint?.(request);
          return {
            ...(sessionRef ? { sessionRef } : {}),
            ...(runtimeHint ? { runtimeHint } : {}),
          };
        } catch (error) {
          client.logger.warn(
            `[epode] session/runtime evidence failed; customer enrichment was skipped. ${String(error)}`,
          );
          return undefined;
        }
      };

      const enrich = (
        surface: "http_json" | "html",
        sendOriginal: () => Response,
        sendEnriched: (contract: AgentEnrichmentRequest) => Response,
      ): Response => {
        const resolvedIdentity = resolveIdentity();
        if (!resolvedIdentity) return sendOriginal();
        const evidence = resolveEvidence();
        if (!evidence) return sendOriginal();
        const stable = Boolean(
          resolvedIdentity.accountRef ||
            resolvedIdentity.userRef ||
            resolvedIdentity.anonymousRef ||
            resolvedIdentity.customerRef,
        );
        void client.enrichment
          .request({
            ...resolvedIdentity,
            interactionId: interactionId(request) || randomUUID(),
            operation: routeOperation(request, options),
            surface,
            statusCode: response.statusCode,
            durationMs: Math.min(Date.now() - startedAt, 86_400_000),
            ...evidence,
            purpose: options.purpose || "product_personalization",
            remember: options.remember ?? stable,
          })
          .then((enrichment) => {
            if (response.headersSent || response.writableEnded) return response;
            if (!enrichment) return sendOriginal();
            return sendEnriched(sameOriginEnrichmentRequest(enrichment));
          })
          .catch(() => {
            if (response.headersSent || response.writableEnded) return response;
            return sendOriginal();
          });
        return response;
      };

      response.json = ((body: unknown) => {
        if (sent) return response;
        sent = true;
        const eligible =
          response.statusCode >= 200 &&
          response.statusCode < 300 &&
          response.statusCode !== 204 &&
          isPlainObject(body) &&
          !Object.hasOwn(body, "_epode");
        if (!eligible) return originalJson(body);
        if (options.shouldRequest) {
          try {
            if (!options.shouldRequest(request, body)) return originalJson(body);
          } catch (error) {
            client.logger.warn(
              `[epode] shouldRequest failed; the original product response was preserved. ${String(error)}`,
            );
            return originalJson(body);
          }
        }
        return enrich(
          "http_json",
          () => originalJson(body),
          (contract) => {
            prepareMutatedResponse(response);
            return originalJson({ ...body, _epode: { customerContext: contract } });
          },
        );
      }) as Response["json"];

      response.send = ((body: unknown) => {
        if (sent) return originalSend(body);
        sent = true;
        const eligible =
          response.statusCode >= 200 &&
          response.statusCode < 300 &&
          response.statusCode !== 204 &&
          looksLikeHtml(response, body);
        if (!eligible) return originalSend(body);
        if (options.shouldRequestHtml) {
          try {
            if (!options.shouldRequestHtml(request, body)) return originalSend(body);
          } catch (error) {
            client.logger.warn(
              `[epode] shouldRequestHtml failed; the original HTML was preserved. ${String(error)}`,
            );
            return originalSend(body);
          }
        }
        return enrich(
          "html",
          () => originalSend(body),
          (contract) => {
            const html = injectCustomerContextHtml(body, contract, maxHtmlBytes);
            if (!html) {
              client.logger.warn(
                "[epode] HTML enrichment skipped because the document is oversized or already owns the Epode marker.",
              );
              return originalSend(body);
            }
            prepareMutatedResponse(response);
            return originalSend(html);
          },
        );
      }) as Response["send"];
      next();
    };

    if (!options.authenticate) {
      instrument();
      return;
    }
    let continued = false;
    try {
      const pending = options.authenticate(request, response, (error?: unknown) => {
        if (continued) return;
        continued = true;
        if (error) next(error);
        else instrument();
      });
      if (pending && typeof (pending as Promise<unknown>).then === "function") {
        void Promise.resolve(pending).catch((error) => {
          if (!continued) next(error);
        });
      }
    } catch (error) {
      next(error);
    }
  }) as EpodeExpress;
  middleware.client = client;
  middleware.context = client.context;
  middleware.personalization = client.personalization;
  middleware.outcomes = client.outcomes;
  middleware.interactionId = interactionId;
  middleware.contextFor = async (
    request,
    purpose = options.purpose || "product_personalization",
  ) => {
    try {
      return await client.context.get({
        ...identity(request),
        ...(interactionId(request) ? { interactionId: interactionId(request) } : {}),
        purpose,
      });
    } catch (error) {
      client.logger.warn(
        `[epode] identify failed during context retrieval; the normal product experience should be used. ${String(error)}`,
      );
      return { available: false, identityLevel: "ephemeral", items: [] };
    }
  };
  return middleware;
}
