export const SETUP_SURFACES = {
  api: {
    name: "HTTP API",
    description: "Add permissioned customer-answer requests to selected JSON responses.",
    stacks: ["node-express", "node-fastify"],
  },
  website: {
    name: "Server-rendered website",
    description: "Instrument selected server-rendered responses without exposing the product key.",
    stacks: ["node-express", "node-fastify"],
  },
  mcp: {
    name: "MCP server",
    description:
      "Register company-owned permission and answer tools beside selected product tools.",
    stacks: ["node-mcp"],
  },
} as const;

export type SetupSurface = keyof typeof SETUP_SURFACES;
export type SetupStack = "node-express" | "node-fastify" | "node-mcp";

const STACK_NAMES: Record<SetupStack, string> = {
  "node-express": "Node · Express",
  "node-fastify": "Node · Fastify",
  "node-mcp": "Node · MCP",
};

type Instructions = { install: string; code: string; verify: string };

export const LINKED_SESSION_CONTRACT = `Use a stable typed Customer identity and a stable opaque workflow ID owned by your product. Resolve sessionRef from authenticated product state only after proving that workflow belongs to that Customer. Reuse the canonical ID returned by workflow creation for follow-ups, cached results, and deduplicated creates; omit sessionRef when that proof is missing or invalid. Never substitute request or trace IDs, telemetry-only cache keys, transport sessions, caller-controlled or model/tool-proposed values, timestamps, prompts, labels, or customerRef. With typed refs, customerId may show Epode's resolved linkage while raw customerRef remains absent; a legacy Ask-once customerRef, when deliberately configured, is retained but is never Session proof. Keep plaintext account/user/anonymous/session references, arguments, prompts, results, credentials, and exceptions out of persistence and the dashboard.`;

export const LINKED_SESSION_VERIFICATION = `Using one authenticated Customer, create Run A, replay its cached or deduplicated result, and send an ordered follow-up with the canonical result-derived workflow ID; all must appear in Session A. Create Run B with its own ordered follow-up and confirm it appears in a separate Session B with no mixing. In response records, confirm missing and invalid ownership proof remain unlinked. In the product client, confirm normal calls still succeed during an Epode outage. Audit persistence/dashboard for plaintext typed identity or Session references, arguments, prompts, results, credentials, or exceptions.`;

export function stackName(stack: SetupStack): string {
  return STACK_NAMES[stack];
}

export function setupInstructions(
  stack: SetupStack,
  surface: SetupSurface,
  _origin: string,
): Instructions {
  const route = surface === "website" ? "/recommendations" : "/api/recommendations";
  const install = "npm install @epode/node@0.4 express";

  if (stack === "node-express") {
    return {
      install,
      code: `import { epode } from "@epode/node/express";

app.use(express.json());
app.use(productAuthentication);
app.use(issueOrVerifyFirstPartyVisitor);

// Product code stores the opaque ID returned by createWorkflow after checking Customer ownership.
// Follow-ups reload that same canonical ID; failed/missing ownership proof leaves this undefined.
app.use(loadOwnedWorkflowFromProductState);
// A successful create handler sets req.ownedWorkflow from its result before response serialization.

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  include: ["${route}"],
  purpose: "product_personalization",
  identify: req => ({
    accountRef: req.user?.accountId,
    userRef: req.user?.id,
    anonymousRef: req.firstPartyVisitorId,
  }),
  sessionRef: req => req.ownedWorkflow?.canonicalId,
});

app.use(customer);`,
      verify: `Call https://your-product.example${route}, confirm the original fields remain intact, and inspect _epode.customerContext.`,
    };
  }

  if (stack === "node-fastify") {
    return {
      install: "npm install @epode/node@0.4 fastify",
      code: `import { epode } from "@epode/node/fastify";

app.addHook("preHandler", productAuthentication);
app.addHook("preHandler", issueOrVerifyFirstPartyVisitor);
app.addHook("preHandler", loadOwnedWorkflowFromProductState);
// A successful create handler sets request.ownedWorkflow from its result before response serialization.

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  include: ["${route}"],
  purpose: "product_personalization",
  identify: request => ({
    accountRef: request.user?.accountId,
    userRef: request.user?.id,
    anonymousRef: request.firstPartyVisitorId,
  }),
  sessionRef: request => request.ownedWorkflow?.canonicalId,
});

await app.register(customer);`,
      verify: `Call https://your-product.example${route}, confirm the original fields remain intact, and inspect _epode.customerContext.`,
    };
  }

  return {
    install:
      "npm install @epode/node@0.4 @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express zod",
    code: `import { epode } from "@epode/node/mcp";

const ownedWorkflowByInvocation = new WeakMap<object, string>();

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  includeTools: ["search_products"],
  purpose: "product_personalization",
  identify: (args, context, result) => {
    const authenticatedCustomer = customers.fromAuthInfo(context.http?.authInfo);
    const candidate = workflowCandidate(args, result);
    // Typed result/input IDs are candidates only; the product registry returns its canonical owned ID.
    const ownedWorkflow = workflows.findOwned(authenticatedCustomer, candidate);
    if (ownedWorkflow) ownedWorkflowByInvocation.set(context, ownedWorkflow.canonicalId);
    return authenticatedCustomer.refs;
  },
  // The customer MCP API calls sessionRef with context only, so identify hands off proof per invocation.
  sessionRef: context => ownedWorkflowByInvocation.get(context),
});

customer.instrument(server);
// Register selected product tools after instrumenting the server.`,
    verify:
      "Call a selected product tool from a real MCP client and confirm the result contains _epode.customerContext and the company-owned permission tools.",
  };
}

export function setupAgentPrompt(
  surface: SetupSurface,
  stack: SetupStack,
  instructions: Instructions,
  _origin: string,
): string {
  const boundary =
    surface === "mcp"
      ? "Keep includeTools limited to customer-facing product tools."
      : "Keep include limited to customer-facing product routes.";
  return `Install Epode's company-side customer-answer integration in this repository.

Surface: ${SETUP_SURFACES[surface].name}
Stack: ${stackName(stack)}

Requirements:
- Use EPODE_API_KEY only from the server environment. Never print, log, or expose it.
- Install exactly: ${instructions.install}
- Run existing product authentication before Epode. accountRef and userRef may come only from verified server state; anonymousRef may come only from a product-owned first-party visitor ID.
- ${LINKED_SESSION_CONTRACT}
- ${boundary}
- Keep the original product result and error behavior intact.
- Do not invent customer identity, permission, answers, or a successful verification.

Reference integration:

${instructions.code}

Verification:
${instructions.verify}
${LINKED_SESSION_VERIFICATION}`;
}
