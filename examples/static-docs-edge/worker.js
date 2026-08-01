import { createStaticDocsProxy } from "@agent-feedback/node/edge";

let proxy;

export default {
  fetch(request, env, context) {
    proxy ??= createStaticDocsProxy({
      apiKey: env.AGENT_FEEDBACK_KEY,
      endpoint: env.AGENT_FEEDBACK_URL,
      feedbackMode: env.AGENT_FEEDBACK_MODE || "never_ask",
      // This must be the separate hostname that serves the unproxied docs.
      upstreamOrigin: env.DOCS_UPSTREAM_ORIGIN,
      include: ["/docs", "/docs/**"],
    });
    return proxy.fetch(request, context);
  },
};
