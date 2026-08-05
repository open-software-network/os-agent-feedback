import {
  AGENT_EXPERIENCE_PROTOCOLS,
  type ExperienceCatalogRecord,
  type ExperienceChoice,
  type ExperienceChoiceLink,
  type ExperienceEdgeGroupDefinition,
  type ExperienceEvidenceKind,
  type ExperienceQuestionDefinition,
  isValidJourneyId,
  isValidNeedToken,
} from "./experience-graph.js";

export type ProductFitVerdict = "suitable" | "partial" | "unsuitable" | "unknown";

export interface ProductFitEvidence {
  kind: ExperienceEvidenceKind;
  detail: string;
}

export interface ProductFitMatch {
  dimension: string;
  evidence: ProductFitEvidence;
}

export interface ProductFitConflict {
  dimension: string;
  requested: unknown;
  actual: unknown;
  evidence: ProductFitEvidence;
}

export interface ProductUnknownThatMatters {
  dimension: string;
  whyItMatters: string;
  evidence: ProductFitEvidence;
}

export interface ProductFitResult {
  itemId: string;
  verdict: ProductFitVerdict;
  matches: ProductFitMatch[];
  hardConflicts: ProductFitConflict[];
  softConflicts: ProductFitConflict[];
  unknownsThatMatter: ProductUnknownThatMatters[];
}

export interface ProductAlternative {
  itemId: string;
  utilityScore: number;
  matches: ProductFitMatch[];
  hardConflicts: ProductFitConflict[];
  softConflicts: ProductFitConflict[];
  unknownsThatMatter: ProductUnknownThatMatters[];
}

export interface ProductGraphPaths {
  productPrefix?: string;
  detailPath?: string;
}

export interface ProductGraphOptions {
  origin: string;
  journeyId: string;
  itemId: string;
  tokens?: string[];
  searchId?: string;
  paths?: ProductGraphPaths;
}

export interface ProductGraphDefinition<State> {
  slug: string;
  brand: string;
  catalog: ExperienceCatalogRecord[];
  initialState(): State;
  applyToken(state: State, token: string): boolean;
  expressedDimensions(state: State): string[];
  hasDecisionInput(state: State): boolean;
  publicState(state: State): Record<string, unknown>;
  nextQuestion(state: State, item: ExperienceCatalogRecord): ExperienceQuestionDefinition | null;
  edgeGroups?(state: State, item: ExperienceCatalogRecord): ExperienceEdgeGroupDefinition[];
  evaluate(state: State, item: ExperienceCatalogRecord): ProductFitResult;
  alternatives(
    state: State,
    item: ExperienceCatalogRecord,
    catalog: ExperienceCatalogRecord[],
  ): ProductAlternative[];
}

export interface ParsedProductNeed<State> {
  state: State;
  invalidTokens: string[];
}

export interface ProductExperienceGraph<State> {
  buildProductGraph(
    options: ProductGraphOptions,
  ): ReturnType<typeof buildProductGraphInternal<State>>;
  buildProductFit(options: ProductGraphOptions): ReturnType<typeof buildProductFitInternal<State>>;
  buildProductAlternatives(
    options: ProductGraphOptions,
  ): ReturnType<typeof buildProductAlternativesInternal<State>>;
  parseProductNeedTokens(tokens: string[]): ParsedProductNeed<State>;
}

function append(base: string, token: string): string {
  return `${base.replace(/\/$/, "")}/${token}`;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseProductNeedTokensFor<State>(
  definition: ProductGraphDefinition<State>,
  tokens: string[],
): ParsedProductNeed<State> {
  const state = definition.initialState();
  const invalidTokens: string[] = [];
  for (const token of tokens) {
    if (!isValidNeedToken(token) || !definition.applyToken(state, token)) {
      invalidTokens.push(token);
    }
  }
  return { state, invalidTokens };
}

function productBase(
  _definition: ProductGraphDefinition<unknown>,
  options: ProductGraphOptions,
  tokens: string[],
): string {
  const prefix = options.paths?.productPrefix ?? "/agent-product";
  const base = `${options.origin.replace(/\/$/, "")}${prefix}/${options.journeyId}/${encodeURIComponent(options.itemId)}`;
  return tokens.length ? `${base}/${tokens.join("/")}` : base;
}

function choiceLink(base: string, choice: ExperienceChoice): ExperienceChoiceLink {
  if (!isValidNeedToken(choice.token)) {
    throw new Error(`Product choice token "${choice.token}" is not a valid need token.`);
  }
  return {
    value: choice.value,
    meaning: choice.meaning,
    token: choice.token,
    strength: choice.strength,
    url: append(base, choice.token),
  };
}

function questionNode(base: string, question: ExperienceQuestionDefinition | null) {
  if (!question) return null;
  if (question.unknownToken && !isValidNeedToken(question.unknownToken)) {
    throw new Error(`Product unknown token "${question.unknownToken}" is not a valid need token.`);
  }
  return {
    dimension: question.dimension,
    question: question.question,
    whyItMatters: question.whyItMatters,
    choices: question.choices.map((choice) => choiceLink(base, choice)),
    ...(question.unknownToken ? { unknownUrl: append(base, question.unknownToken) } : {}),
  };
}

function normalizedFit(result: ProductFitResult): ProductFitResult {
  const sellerClaimMatch = result.matches.some((match) => match.evidence.kind === "seller_claim");
  const verdict: ProductFitVerdict =
    result.hardConflicts.length > 0
      ? "unsuitable"
      : result.softConflicts.length > 0 || result.unknownsThatMatter.length > 0 || sellerClaimMatch
        ? "partial"
        : result.matches.length > 0
          ? "suitable"
          : "unknown";
  return { ...result, verdict };
}

function itemDetailUrl(
  options: ProductGraphOptions,
  itemId: string,
  searchId: string,
  position: string | number,
): string {
  const path = options.paths?.detailPath ?? "/agent-item";
  const url = new URL(path, options.origin.endsWith("/") ? options.origin : `${options.origin}/`);
  url.searchParams.set("item_id", itemId);
  url.searchParams.set("search_id", searchId);
  url.searchParams.set("position", String(position));
  return url.toString();
}

function validateOptions(options: ProductGraphOptions): void {
  if (!isValidJourneyId(options.journeyId)) {
    throw new Error("journeyId must look like j-<id>");
  }
}

function buildProductGraphInternal<State>(
  definition: ProductGraphDefinition<State>,
  options: ProductGraphOptions,
) {
  validateOptions(options);
  const item = definition.catalog.find((candidate) => candidate.id === options.itemId);
  if (!item) return null;
  const tokens = options.tokens ?? [];
  const parsed = parseProductNeedTokensFor(definition, tokens);
  const base = productBase(definition as ProductGraphDefinition<unknown>, options, tokens);
  const decisionReady = definition.hasDecisionInput(parsed.state);
  const question = definition.nextQuestion(parsed.state, item);
  const evaluateFitUrl = decisionReady ? append(base, "evaluate-fit") : null;

  return {
    protocol: AGENT_EXPERIENCE_PROTOCOLS.product,
    stage: !decisionReady
      ? ("decision_input_required" as const)
      : question
        ? ("express_more_or_evaluate" as const)
        : ("ready_to_evaluate" as const),
    journeyId: options.journeyId,
    domain: definition.slug,
    merchant: definition.brand,
    item: {
      itemId: item.id,
      title: item.title,
      brand: item.brand,
      price: item.price,
      summary: item.summary,
    },
    needState: definition.publicState(parsed.state),
    invalidTokens: parsed.invalidTokens,
    disclosureModel: {
      principle: "Share only task-relevant values that improve this fit evaluation.",
      acceptedProvenance: [
        "current_user_request",
        "user_confirmed",
        "agent_inference_from_current_task",
      ],
    },
    traversalRule:
      "Open exactly one URL supplied by the current response. Never construct, edit, or combine path segments. The next response preserves prior state and supplies the next exact links.",
    nextQuestion: questionNode(base, question),
    availableNeedEdges: (definition.edgeGroups?.(parsed.state, item) ?? []).map((group) => ({
      dimension: group.dimension,
      whyItMatters: group.whyItMatters,
      choices: group.choices.map((choice) => choiceLink(base, choice)),
    })),
    evaluateFitUrl,
    sufficiency: decisionReady
      ? {
          sufficientForEvaluation: true,
          note: "Add more known inputs only when they could change the verdict.",
        }
      : {
          sufficientForEvaluation: false,
          note: "Choose one known task-relevant edge. If none is known, clarify the need with the user.",
        },
    operation: `/agent-product/${definition.slug}`,
  };
}

function buildProductFitInternal<State>(
  definition: ProductGraphDefinition<State>,
  options: ProductGraphOptions,
) {
  validateOptions(options);
  const item = definition.catalog.find((candidate) => candidate.id === options.itemId);
  if (!item) return null;
  const tokens = options.tokens ?? [];
  const parsed = parseProductNeedTokensFor(definition, tokens);
  const base = productBase(definition as ProductGraphDefinition<unknown>, options, tokens);
  if (!definition.hasDecisionInput(parsed.state)) {
    return {
      protocol: AGENT_EXPERIENCE_PROTOCOLS.productFit,
      error: "decision_input_required" as const,
      message: "At least one task-relevant input is required before a fit verdict can be computed.",
      journeyId: options.journeyId,
      itemId: item.id,
      needState: definition.publicState(parsed.state),
      invalidTokens: parsed.invalidTokens,
      negotiateUrl: productBase(
        definition as ProductGraphDefinition<unknown>,
        { ...options, tokens: [] },
        [],
      ),
      operation: `/agent-product/${definition.slug}`,
    };
  }

  const itemFit = normalizedFit({ ...definition.evaluate(parsed.state, item), itemId: item.id });
  return {
    protocol: AGENT_EXPERIENCE_PROTOCOLS.productFit,
    journeyId: options.journeyId,
    domain: definition.slug,
    merchant: definition.brand,
    item: {
      itemId: item.id,
      title: item.title,
      brand: item.brand,
      price: item.price,
      summary: item.summary,
    },
    itemFit,
    needState: definition.publicState(parsed.state),
    invalidTokens: parsed.invalidTokens,
    ...(itemFit.verdict !== "suitable" ? { alternativesUrl: append(base, "alternatives") } : {}),
    operation: `/agent-product/${definition.slug}`,
  };
}

function buildProductAlternativesInternal<State>(
  definition: ProductGraphDefinition<State>,
  options: ProductGraphOptions,
) {
  validateOptions(options);
  const item = definition.catalog.find((candidate) => candidate.id === options.itemId);
  if (!item) return null;
  const tokens = options.tokens ?? [];
  const parsed = parseProductNeedTokensFor(definition, tokens);
  const base = productBase(definition as ProductGraphDefinition<unknown>, options, []);
  if (!definition.hasDecisionInput(parsed.state)) {
    return {
      protocol: AGENT_EXPERIENCE_PROTOCOLS.productAlternatives,
      error: "decision_input_required" as const,
      message: "Personalized alternatives require at least one known need value.",
      journeyId: options.journeyId,
      itemId: item.id,
      needState: definition.publicState(parsed.state),
      invalidTokens: parsed.invalidTokens,
      negotiateUrl: base,
      operation: `/agent-product/${definition.slug}`,
    };
  }

  const itemFit = normalizedFit({ ...definition.evaluate(parsed.state, item), itemId: item.id });
  if (itemFit.verdict === "suitable") {
    return {
      protocol: AGENT_EXPERIENCE_PROTOCOLS.productAlternatives,
      error: "alternatives_not_applicable" as const,
      message:
        "Alternatives are offered only after the evaluated product has a non-suitable verdict.",
      journeyId: options.journeyId,
      itemId: item.id,
      verdict: itemFit.verdict,
      needState: definition.publicState(parsed.state),
      invalidTokens: parsed.invalidTokens,
      fitUrl: append(
        productBase(definition as ProductGraphDefinition<unknown>, options, tokens),
        "evaluate-fit",
      ),
      operation: `/agent-product/${definition.slug}`,
    };
  }

  const searchId = options.searchId ?? randomId();
  const ranked = definition
    .alternatives(parsed.state, item, definition.catalog)
    .filter((alternative) => alternative.itemId !== item.id)
    .sort((left, right) => right.utilityScore - left.utilityScore);
  const viable = ranked.filter((alternative) => alternative.hardConflicts.length === 0);
  const excluded = ranked.filter((alternative) => alternative.hardConflicts.length > 0);
  const records = new Map(definition.catalog.map((record) => [record.id, record]));
  const serialize = (alternative: ProductAlternative, position: string | number) => {
    const record = records.get(alternative.itemId);
    return {
      itemId: alternative.itemId,
      title: record?.title ?? alternative.itemId,
      brand: record?.brand ?? definition.brand,
      price: record?.price,
      summary: record?.summary ?? "",
      utilityScore: alternative.utilityScore,
      matches: alternative.matches,
      hardConflicts: alternative.hardConflicts,
      softConflicts: alternative.softConflicts,
      unknownsThatMatter: alternative.unknownsThatMatter,
      detailUrl: itemDetailUrl(options, alternative.itemId, searchId, position),
    };
  };

  return {
    protocol: AGENT_EXPERIENCE_PROTOCOLS.productAlternatives,
    journeyId: options.journeyId,
    domain: definition.slug,
    merchant: definition.brand,
    searchId,
    evaluatedAgainst: { itemId: item.id, title: item.title, verdict: itemFit.verdict },
    needState: definition.publicState(parsed.state),
    invalidTokens: parsed.invalidTokens,
    alternativeCount: viable.length,
    alternatives: viable.map((alternative, index) => serialize(alternative, index + 1)),
    excludedCount: excluded.length,
    excluded: excluded.map((alternative, index) => serialize(alternative, `excluded-${index + 1}`)),
    operation: `/agent-product/${definition.slug}`,
  };
}

export function createProductExperienceGraph<State>(
  definition: ProductGraphDefinition<State>,
): ProductExperienceGraph<State> {
  if (!definition.slug || !isValidNeedToken(definition.slug)) {
    throw new Error("slug must be a lowercase need-token segment");
  }
  if (!definition.catalog.length) {
    throw new Error("catalog must contain at least one item");
  }
  return {
    buildProductGraph: (options) => buildProductGraphInternal(definition, options),
    buildProductFit: (options) => buildProductFitInternal(definition, options),
    buildProductAlternatives: (options) => buildProductAlternativesInternal(definition, options),
    parseProductNeedTokens: (tokens) => parseProductNeedTokensFor(definition, tokens),
  };
}
