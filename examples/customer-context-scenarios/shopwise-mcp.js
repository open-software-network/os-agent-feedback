export const SHOPWISE_HARNESS_BOUNDARIES = Object.freeze({
  toolApproval: "host_owned",
  approvalCadence:
    "The MCP host may ask once per tool call. Tool annotations are hints and cannot suppress host approvals.",
  deniedCall:
    "A host denial happens before the server receives a tools/call request, so the server records nothing.",
  shareCustomerContextRequired: false,
});

export const SHOPWISE_TOOLS = Object.freeze([
  {
    name: "search_catalog",
    title: "Search Shopwise catalog",
    description:
      "Search once using bounded shopping context and return results with an exact received/applied context and data-use receipt. Context exists only for this tool call and is never saved to a profile.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["shopperContext"],
      properties: {
        shopperContext: {
          type: "object",
          additionalProperties: false,
          required: ["size", "width", "colors", "useCase", "budget", "features"],
          properties: {
            size: { type: "string", minLength: 1, maxLength: 30 },
            width: { type: "string", enum: ["standard", "wide", "extra_wide"] },
            colors: {
              type: "object",
              additionalProperties: false,
              required: ["preferred", "excluded"],
              properties: {
                preferred: { type: "array", items: { type: "string" }, maxItems: 20 },
                excluded: { type: "array", items: { type: "string" }, maxItems: 20 },
              },
            },
            useCase: { type: "string", minLength: 1, maxLength: 160 },
            budget: {
              type: "object",
              additionalProperties: false,
              required: ["currency", "max"],
              properties: {
                currency: { type: "string", enum: ["USD"] },
                max: { type: "number", minimum: 1, maximum: 1000 },
              },
            },
            features: {
              type: "object",
              additionalProperties: false,
              required: ["required", "excluded"],
              properties: {
                required: { type: "array", items: { type: "string" }, maxItems: 30 },
                excluded: { type: "array", items: { type: "string" }, maxItems: 30 },
              },
            },
            brands: {
              type: "object",
              additionalProperties: false,
              properties: {
                preferred: { type: "array", items: { type: "string" }, maxItems: 20 },
                excluded: { type: "array", items: { type: "string" }, maxItems: 20 },
              },
            },
          },
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
]);

export const SHOPWISE_CATALOG = Object.freeze([
  {
    id: "harbor-run-2e",
    name: "Harbor Run 2E",
    brand: "Harbor",
    price: 118,
    currency: "USD",
    sizes: ["9", "9.5", "10", "10.5", "11"],
    widths: ["wide", "extra_wide"],
    colors: ["black", "graphite", "navy"],
    useCases: ["daily road running"],
    features: ["roomy toe box", "moderate cushioning", "road outsole"],
  },
  {
    id: "canyon-cloud-wide",
    name: "Canyon Cloud Wide",
    brand: "Canyon",
    price: 139,
    currency: "USD",
    sizes: ["9", "10", "11", "12"],
    widths: ["wide"],
    colors: ["black", "sand"],
    useCases: ["daily road running", "mixed-surface running"],
    features: ["roomy toe box", "firm cushioning", "trail outsole"],
  },
  {
    id: "northstar-flash",
    name: "Northstar Flash",
    brand: "Northstar",
    price: 129,
    currency: "USD",
    sizes: ["10", "11"],
    widths: ["standard", "wide"],
    colors: ["neon lime"],
    useCases: ["daily road running"],
    features: ["responsive cushioning", "road outsole"],
  },
]);

const CONTEXT_KEYS = new Set([
  "size",
  "width",
  "colors",
  "useCase",
  "budget",
  "features",
  "brands",
]);

const requireObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShopwiseMcpError("INVALID_INPUT", `${label} must be an object`);
  }
  return value;
};

const rejectUnknown = (value, allowed, label) => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ShopwiseMcpError(
      "UNSUPPORTED_CONTEXT",
      `${label} contains unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
};

const text = (value, label) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new ShopwiseMcpError("INVALID_INPUT", `${label} must be a non-empty string`);
  }
  return value.trim().toLowerCase();
};

const list = (value, label) => {
  if (!Array.isArray(value)) {
    throw new ShopwiseMcpError("INVALID_INPUT", `${label} must be an array`);
  }
  return [...new Set(value.map((item, index) => text(item, `${label}[${index}]`)))].sort();
};

const optionalGroup = (value, label) => {
  if (value === undefined) return { preferred: [], excluded: [] };
  const group = requireObject(value, label);
  rejectUnknown(group, new Set(["preferred", "excluded"]), label);
  return {
    preferred: list(group.preferred || [], `${label}.preferred`),
    excluded: list(group.excluded || [], `${label}.excluded`),
  };
};

export function normalizeShopperContext(value) {
  const input = requireObject(value, "shopperContext");
  rejectUnknown(input, CONTEXT_KEYS, "shopperContext");

  const width = text(input.width, "shopperContext.width");
  if (!new Set(["standard", "wide", "extra_wide"]).has(width)) {
    throw new ShopwiseMcpError("INVALID_INPUT", "shopperContext.width is unsupported");
  }

  const colors = requireObject(input.colors, "shopperContext.colors");
  rejectUnknown(colors, new Set(["preferred", "excluded"]), "shopperContext.colors");
  const features = requireObject(input.features, "shopperContext.features");
  rejectUnknown(features, new Set(["required", "excluded"]), "shopperContext.features");
  const budget = requireObject(input.budget, "shopperContext.budget");
  rejectUnknown(budget, new Set(["currency", "max"]), "shopperContext.budget");
  if (budget.currency !== "USD" || typeof budget.max !== "number" || budget.max < 1) {
    throw new ShopwiseMcpError(
      "INVALID_INPUT",
      "shopperContext.budget must contain a positive USD maximum",
    );
  }

  return {
    size: text(input.size, "shopperContext.size"),
    width,
    colors: {
      preferred: list(colors.preferred, "shopperContext.colors.preferred"),
      excluded: list(colors.excluded, "shopperContext.colors.excluded"),
    },
    useCase: text(input.useCase, "shopperContext.useCase"),
    budget: { currency: "USD", max: budget.max },
    features: {
      required: list(features.required, "shopperContext.features.required"),
      excluded: list(features.excluded, "shopperContext.features.excluded"),
    },
    brands: optionalGroup(input.brands, "shopperContext.brands"),
  };
}

export class ShopwiseMcpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ShopwiseMcpError";
    this.code = code;
  }
}

const clone = (value) => structuredClone(value);

const dataUseReceipt = (identityMode) => ({
  personalization: "task_context_only",
  scope: "current_tool_call",
  retention: "none",
  expiresInSeconds: 0,
  savedToProfile: false,
  assistantMemoryImported: false,
  identityMode,
});

const productMatches = (product, context) => {
  const usableColors = product.colors.filter(
    (color) => !context.colors.excluded.includes(color),
  );
  const preferredColorMatch =
    context.colors.preferred.length === 0 ||
    usableColors.some((color) => context.colors.preferred.includes(color));
  const preferredBrandMatch =
    context.brands.preferred.length === 0 ||
    context.brands.preferred.includes(product.brand.toLowerCase());
  const checks = {
    size: product.sizes.includes(context.size),
    width: product.widths.includes(context.width),
    color: usableColors.length > 0 && preferredColorMatch,
    useCase: product.useCases.includes(context.useCase),
    budget: product.currency === context.budget.currency && product.price <= context.budget.max,
    requiredFeatures: context.features.required.every((feature) =>
      product.features.includes(feature),
    ),
    excludedFeatures: context.features.excluded.every(
      (feature) => !product.features.includes(feature),
    ),
    preferredBrand: preferredBrandMatch,
    excludedBrand: !context.brands.excluded.includes(product.brand.toLowerCase()),
  };
  return { matches: Object.values(checks).every(Boolean), checks, usableColors };
};

export class ShopwiseMcpExample {
  #audit = [];

  listTools() {
    return clone(SHOPWISE_TOOLS);
  }

  auditTrail() {
    return clone(this.#audit);
  }

  callTool(name, args, runtime = {}) {
    const sessionId = text(runtime.sessionId, "runtime.sessionId");
    const identityMode = runtime.incognito ? "incognito" : "standard";
    this.#audit.push({ name, sessionId, identityMode });

    if (name === "search_catalog") {
      const input = requireObject(args, "arguments");
      rejectUnknown(input, new Set(["shopperContext"]), "arguments");
      const appliedContext = normalizeShopperContext(input.shopperContext);
      const evaluated = SHOPWISE_CATALOG.map((product) => ({
        product,
        ...productMatches(product, appliedContext),
      }));
      const matches = evaluated
        .filter((item) => item.matches)
        .map(({ product, usableColors }) => ({
          id: product.id,
          name: product.name,
          brand: product.brand,
          price: product.price,
          currency: product.currency,
          availableColorsAfterExclusions: usableColors,
        }));
      const structuredContent = {
        matches,
        receivedContext: clone(input.shopperContext),
        appliedContext: clone(appliedContext),
        contextReceipt: {
          receivedFields: [
            "size",
            "width",
            "colors.preferred",
            "colors.excluded",
            "useCase",
            "budget.currency",
            "budget.max",
            "features.required",
            "features.excluded",
            "brands.preferred",
            "brands.excluded",
          ],
          usedEveryAcceptedField: true,
          ignoredFields: [],
        },
        dataUse: dataUseReceipt(identityMode),
        matchTrace: evaluated.map(({ product, checks }) => ({
          productId: product.id,
          checks,
        })),
      };
      return {
        content: [
          {
            type: "text",
            text: `Shopwise found ${matches.length} matches using every field in appliedContext.`,
          },
        ],
        structuredContent,
      };
    }

    throw new ShopwiseMcpError("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
  }
}
