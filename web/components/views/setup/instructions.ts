export const SETUP_SURFACES = {
  api: {
    name: "HTTP API",
    description: "Add permissioned customer-context requests to selected JSON responses.",
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
      "Register company-owned permission and context tools beside selected product tools.",
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

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  include: ["${route}"],
  purpose: "product_personalization",
  identify: req => ({
    accountRef: req.user?.accountId,
    userRef: req.user?.id,
    anonymousRef: req.firstPartyVisitorId,
  }),
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

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  include: ["${route}"],
  purpose: "product_personalization",
  identify: request => ({
    accountRef: request.user?.accountId,
    userRef: request.user?.id,
    anonymousRef: request.firstPartyVisitorId,
  }),
});

await app.register(customer);`,
      verify: `Call https://your-product.example${route}, confirm the original fields remain intact, and inspect _epode.customerContext.`,
    };
  }

  return {
    install:
      "npm install @epode/node@0.4 @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express zod",
    code: `import { epode } from "@epode/node/mcp";

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  includeTools: ["search_products"],
  purpose: "product_personalization",
  identify: (_args, context) => ({
    accountRef: context.http?.authInfo?.extra?.accountId,
    userRef: context.http?.authInfo?.extra?.userId,
    anonymousRef: context.http?.authInfo?.extra?.visitorId,
  }),
});

customer.instrument(server);
// Register selected product tools after instrumenting the server.`,
    verify:
      "Call a selected product tool from a real MCP client and confirm the result contains _epode.customerContext and the company-owned consent/context tools.",
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
  return `Install Epode's company-side customer-context integration in this repository.

Surface: ${SETUP_SURFACES[surface].name}
Stack: ${stackName(stack)}

Requirements:
- Use EPODE_API_KEY only from the server environment. Never print, log, or expose it.
- Install exactly: ${instructions.install}
- Run existing product authentication before Epode. accountRef and userRef may come only from verified server state; anonymousRef may come only from a product-owned first-party visitor ID.
- ${boundary}
- Keep the original product result and error behavior intact.
- Do not invent customer identity, permission, context, or a successful verification.

Reference integration:

${instructions.code}

Verification:
${instructions.verify}`;
}
