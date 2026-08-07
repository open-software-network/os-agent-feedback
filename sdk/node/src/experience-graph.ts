/**
 * Agent experience graph: merchant-authored need negotiation for agent clients.
 *
 * The durable product is a machine-readable experience graph. Agents express
 * only current-task utility through exact merchant-supplied transitions. The
 * company receives causal journey telemetry through ordinary Epode sessions.
 *
 * Transport is intentionally abstract. URL path tokens are one encoding; MCP
 * tool arguments or structured HTTP bodies can carry the same need state.
 */

export type ConstraintStrength = "hard" | "preference" | "target";

export type ExperienceDimensionKind = "enum" | "budget" | "priority" | "evidence" | "flexibility";

export interface ExperienceChoice {
  /** Token segment written into the need path. */
  token: string;
  /** Stable value stored in need state. */
  value: string;
  /** Human-readable meaning for agents and UIs. */
  meaning: string;
  /** Optional constraint strength encoded by this choice. */
  strength?: ConstraintStrength;
}

export interface ExperienceDimension {
  key: string;
  kind: ExperienceDimensionKind;
  question: string;
  whyItMatters: string;
  /** Generic first-step label for the decision-anchor stage. */
  anchorMeaning: string;
  choices: ExperienceChoice[];
  /** Allow an explicit unknown answer without inventing a value. */
  allowUnknown?: boolean;
  /** Optional skip once at least one decision input exists. */
  optional?: boolean;
}

export interface ExperienceItem {
  id: string;
  title: string;
  brand?: string;
  category?: string;
  price?: { amount: number; currency?: string };
  attributes?: Record<string, string | number | boolean | string[] | undefined>;
  /** Dimension key -> catalog values used for hard/soft matching. */
  matches?: Record<string, string[]>;
}

export interface ExperienceGraphDefinition {
  protocol?: string;
  category: string;
  dimensions: ExperienceDimension[];
  items: ExperienceItem[];
  /**
   * Dimensions that may not count as decision inputs by themselves.
   * Defaults to `*_unknown` markers only.
   */
  nonDecisionDimensions?: string[];
  /** Score boosts when a priority dimension is present. */
  priorityWeights?: Record<string, number>;
}

export interface NeedExpression {
  dimension: string;
  value?: string;
  strength?: ConstraintStrength;
  known: boolean;
  token: string;
}

export interface NeedState {
  category: string;
  requestedDimension?: string;
  expressions: NeedExpression[];
  expressedDimensions: string[];
  values: Record<string, { value?: string; strength?: ConstraintStrength; known: boolean }>;
}

export interface ExperienceChoiceLink {
  value: string;
  meaning: string;
  token: string;
  url: string;
  strength?: ConstraintStrength;
}

export interface ExperienceQuestion {
  dimension: string;
  question: string;
  whyItMatters: string;
  choices: ExperienceChoiceLink[];
  unknownUrl?: string;
  skipUrl?: string;
}

export interface FitDimension {
  dimension: string;
  status: "match" | "miss" | "unknown";
  evidence: string;
}

export interface HardFailure {
  dimension: string;
  requested: unknown;
  actual: unknown;
}

export interface RankedItem {
  item: ExperienceItem;
  score: number;
  hardFailures: HardFailure[];
  fitByDimension: FitDimension[];
}

export interface NegotiationNode {
  protocol: string;
  stage: "decision_input_required" | "express_more_or_decide" | "ready_to_decide";
  journeyId: string;
  category: string;
  needState: NeedState;
  invalidTokens: string[];
  disclosureModel: {
    principle: string;
    acceptedProvenance: string[];
    memoryOnlyValues: string;
  };
  traversalRule: string;
  nextQuestion: ExperienceQuestion | null;
  availableNeedEdges: Array<{
    dimension: string;
    whyItMatters: string;
    choices: ExperienceChoiceLink[];
  }>;
  resultsUrl: string | null;
  sufficiency: {
    sufficientForResults: boolean;
    note: string;
  };
  /** Epode-compatible operation label for telemetry. */
  operation: string;
}

export interface DecisionNode {
  protocol: string;
  stage?: "decision_support";
  error?: "decision_input_required";
  message?: string;
  journeyId: string;
  category: string;
  searchId?: string;
  needState: NeedState;
  invalidTokens: string[];
  negotiateUrl?: string;
  exactMatchCount?: number;
  exactMatches?: RecordedMatch[];
  nearMissCount?: number;
  nearMisses?: RecordedMatch[];
  counterfactuals?: RecordedCounterfactual[];
  operation: string;
}

export interface RecordedMatch {
  itemId: string;
  title: string;
  brand?: string;
  price?: { amount: number; currency: string };
  catalogAttributes: Record<string, unknown>;
  utilityScore: number;
  fitByDimension: FitDimension[];
  violatedHardConstraints: HardFailure[];
  detailUrl: string;
}

export interface RecordedCounterfactual {
  change: string;
  effect: string;
  detailUrl: string;
  delta?: number;
}

export interface ExperienceGraphPaths {
  negotiatePrefix?: string;
  decidePrefix?: string;
  detailPath?: string;
}

export interface ExperienceGraphOptions {
  origin: string;
  journeyId: string;
  tokens?: string[];
  searchId?: string;
  paths?: ExperienceGraphPaths;
}

/** Protocol identifiers used by the programmable domain and product graphs. */
export const AGENT_EXPERIENCE_PROTOCOLS = {
  negotiation: "agent-experience-graph/negotiation-2.1",
  decision: "agent-experience-graph/decision-2.1",
  item: "agent-experience-graph/item-1.0",
  product: "agent-experience-graph/product-1.0",
  productFit: "agent-experience-graph/product-fit-1.0",
  productAlternatives: "agent-experience-graph/product-alternatives-1.0",
} as const;

export type ExperienceEvidenceKind = "catalog_fact" | "seller_claim" | "unknown";

export type ExperienceSellerClaimAttribution =
  | "seller_marketing_copy"
  | "manufacturer_claim"
  | "merchant_claim";

export interface ExperienceSellerClaim {
  claim: string;
  attributedTo: ExperienceSellerClaimAttribution;
  verified: boolean;
}

export interface ExperienceCatalogRecord {
  id: string;
  title: string;
  brand: string;
  category: string;
  price: { amount: number; currency: string };
  summary: string;
  attributes: Record<string, string[]>;
  notSpecified: string[];
  sellerClaims: ExperienceSellerClaim[];
}

export interface ExperienceFitLine {
  dimension: string;
  status: "match" | "miss" | "unknown";
  evidence: string;
}

export interface ExperienceViolation {
  dimension: string;
  requested: unknown;
  actual: unknown;
}

export interface ExperienceEvaluatedItem {
  itemId: string;
  utilityScore: number;
  fitByDimension: ExperienceFitLine[];
  violatedHardConstraints: ExperienceViolation[];
}

export interface ExperienceCounterfactual {
  change: string;
  effect: string;
  deltaUsd?: number;
  itemId?: string;
}

export interface ExperienceDomainEvaluation {
  exact: ExperienceEvaluatedItem[];
  nearMisses: ExperienceEvaluatedItem[];
  counterfactuals: ExperienceCounterfactual[];
}

export interface ExperienceQuestionDefinition {
  dimension: string;
  question: string;
  whyItMatters: string;
  choices: ExperienceChoice[];
  unknownToken?: string;
}

export interface ExperienceEdgeGroupDefinition {
  dimension: string;
  whyItMatters: string;
  choices: ExperienceChoice[];
}

/**
 * Programmable domain contract for catalogs whose decision semantics cannot be
 * expressed by the declarative dimension matcher.
 */
export interface AgentExperienceDomain<State> {
  slug: string;
  brand: string;
  entryLabel: string;
  tagline: string;
  catalog: ExperienceCatalogRecord[];
  initialState(): State;
  applyToken(state: State, token: string): boolean;
  expressedDimensions(state: State): string[];
  hasDecisionInput(state: State): boolean;
  publicState(state: State): Record<string, unknown>;
  nextQuestion(state: State): ExperienceQuestionDefinition | null;
  edgeGroups(state: State): ExperienceEdgeGroupDefinition[];
  evaluate(state: State): ExperienceDomainEvaluation;
}

export interface ParsedDomainNeed<State> {
  state: State;
  invalidTokens: string[];
}

const TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JOURNEY_RE = /^j-[a-z0-9-]+$/i;

function snake(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function append(base: string, token: string): string {
  return `${base.replace(/\/$/, "")}/${token}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function dimensionMap(definition: ExperienceGraphDefinition): Map<string, ExperienceDimension> {
  return new Map(definition.dimensions.map((dimension) => [dimension.key, dimension]));
}

function choiceByToken(
  definition: ExperienceGraphDefinition,
  token: string,
): { dimension: ExperienceDimension; choice?: ExperienceChoice; unknown?: boolean } | undefined {
  if (token.startsWith("consider-")) {
    const key = token.slice("consider-".length);
    const dimension = definition.dimensions.find((entry) => entry.key === key);
    return dimension ? { dimension } : undefined;
  }
  for (const dimension of definition.dimensions) {
    if (dimension.allowUnknown && token === `${snake(dimension.key)}-unknown`) {
      return { dimension, unknown: true };
    }
    const choice = dimension.choices.find((entry) => entry.token === token);
    if (choice) return { dimension, choice };
  }
  return undefined;
}

export function isValidNeedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function isValidJourneyId(journeyId: string): boolean {
  return JOURNEY_RE.test(journeyId);
}

export function parseNeedTokens(
  definition: ExperienceGraphDefinition,
  tokens: string[],
): { state: NeedState; invalidTokens: string[] } {
  const state: NeedState = {
    category: definition.category,
    expressions: [],
    expressedDimensions: [],
    values: {},
  };
  const invalidTokens: string[] = [];

  for (const token of tokens) {
    if (!isValidNeedToken(token)) {
      invalidTokens.push(token);
      continue;
    }
    if (token.startsWith("consider-")) {
      const key = token.slice("consider-".length);
      if (!definition.dimensions.some((dimension) => dimension.key === key)) {
        invalidTokens.push(token);
        continue;
      }
      state.requestedDimension = key;
      continue;
    }

    const matched = choiceByToken(definition, token);
    if (!matched) {
      invalidTokens.push(token);
      continue;
    }

    if (matched.unknown) {
      const expression: NeedExpression = {
        dimension: matched.dimension.key,
        known: false,
        token,
      };
      state.expressions.push(expression);
      state.values[matched.dimension.key] = { known: false };
      state.expressedDimensions.push(`${matched.dimension.key}_unknown`);
      continue;
    }

    if (!matched.choice) {
      invalidTokens.push(token);
      continue;
    }

    const expression: NeedExpression = {
      dimension: matched.dimension.key,
      value: matched.choice.value,
      strength: matched.choice.strength,
      known: true,
      token,
    };
    state.expressions.push(expression);
    state.values[matched.dimension.key] = {
      value: matched.choice.value,
      strength: matched.choice.strength,
      known: true,
    };
    state.expressedDimensions.push(matched.dimension.key);
  }

  state.expressedDimensions = unique(state.expressedDimensions);
  return { state, invalidTokens };
}

function nonDecisionSet(definition: ExperienceGraphDefinition): Set<string> {
  return new Set(
    definition.nonDecisionDimensions ??
      definition.dimensions
        .filter((dimension) => dimension.allowUnknown)
        .map((dimension) => `${dimension.key}_unknown`),
  );
}

export function hasDecisionInput(definition: ExperienceGraphDefinition, state: NeedState): boolean {
  const blocked = nonDecisionSet(definition);
  return state.expressedDimensions.some((dimension) => !blocked.has(dimension));
}

function choiceLinks(base: string, dimension: ExperienceDimension): ExperienceChoiceLink[] {
  return dimension.choices.map((choice) => ({
    value: choice.value,
    meaning: choice.meaning,
    token: choice.token,
    strength: choice.strength,
    url: append(base, choice.token),
  }));
}

function nextQuestion(
  definition: ExperienceGraphDefinition,
  base: string,
  resultsUrl: string | null,
  state: NeedState,
): ExperienceQuestion | null {
  const dims = dimensionMap(definition);

  if (state.expressedDimensions.length === 0) {
    if (state.requestedDimension) {
      const dimension = dims.get(state.requestedDimension);
      if (!dimension) return null;
      return {
        dimension: dimension.key,
        question: dimension.question,
        whyItMatters: dimension.whyItMatters,
        choices: choiceLinks(base, dimension),
        ...(dimension.allowUnknown
          ? { unknownUrl: append(base, `${snake(dimension.key)}-unknown`) }
          : {}),
      };
    }
    return {
      dimension: "decision_anchor",
      question: "Which kind of task-relevant input is known for this request?",
      whyItMatters:
        "A recommendation cannot be ranked honestly until at least one constraint, preference, purpose, or priority is known.",
      choices: definition.dimensions.map((dimension) => ({
        value: dimension.key,
        meaning: dimension.anchorMeaning,
        token: `consider-${dimension.key}`,
        url: append(base, `consider-${dimension.key}`),
      })),
    };
  }

  for (const dimension of definition.dimensions) {
    const expressed =
      state.values[dimension.key] !== undefined ||
      state.expressedDimensions.includes(`${dimension.key}_unknown`);
    if (expressed) continue;
    if (dimension.optional && resultsUrl) {
      // Still offer optional dimensions, but allow skip.
    }
    return {
      dimension: dimension.key,
      question: dimension.question,
      whyItMatters: dimension.whyItMatters,
      choices: choiceLinks(base, dimension),
      ...(dimension.allowUnknown
        ? { unknownUrl: append(base, `${snake(dimension.key)}-unknown`) }
        : {}),
      ...(resultsUrl ? { skipUrl: resultsUrl } : {}),
    };
  }
  return null;
}

function availableNeedEdges(
  definition: ExperienceGraphDefinition,
  base: string,
  state: NeedState,
): NegotiationNode["availableNeedEdges"] {
  if (state.expressedDimensions.length === 0 && !state.requestedDimension) {
    return [
      {
        dimension: "decision_anchor",
        whyItMatters:
          "Select a known input type first; the next response provides its catalog-derived values.",
        choices: definition.dimensions.map((dimension) => ({
          value: dimension.key,
          meaning: dimension.anchorMeaning,
          token: `consider-${dimension.key}`,
          url: append(base, `consider-${dimension.key}`),
        })),
      },
    ];
  }

  const groups: NegotiationNode["availableNeedEdges"] = [];
  for (const dimension of definition.dimensions) {
    const expressed =
      state.values[dimension.key] !== undefined ||
      state.expressedDimensions.includes(`${dimension.key}_unknown`);
    if (expressed) continue;
    if (
      state.requestedDimension &&
      state.requestedDimension !== dimension.key &&
      state.expressedDimensions.length === 0
    ) {
      // After consider-*, only that dimension's values are meaningful next.
      continue;
    }
    groups.push({
      dimension: dimension.key,
      whyItMatters: dimension.whyItMatters,
      choices: [
        ...choiceLinks(base, dimension),
        ...(dimension.allowUnknown
          ? [
              {
                value: "unknown",
                meaning: `${dimension.key} is not known from the current task`,
                token: `${snake(dimension.key)}-unknown`,
                url: append(base, `${snake(dimension.key)}-unknown`),
              },
            ]
          : []),
      ],
    });
  }
  return groups;
}

function itemValues(item: ExperienceItem, dimension: string): string[] {
  const fromMatches = item.matches?.[dimension];
  if (fromMatches) return fromMatches.map((value) => value.toLowerCase());
  const attribute = item.attributes?.[dimension];
  if (Array.isArray(attribute)) return attribute.map((value) => String(value).toLowerCase());
  if (attribute === undefined || attribute === null) return [];
  return [String(attribute).toLowerCase()];
}

function evaluateItem(
  definition: ExperienceGraphDefinition,
  item: ExperienceItem,
  state: NeedState,
): RankedItem {
  const hardFailures: HardFailure[] = [];
  const fitByDimension: FitDimension[] = [];
  let score = 0;
  const priority = state.values.priority?.value;
  const priorityWeights = definition.priorityWeights ?? {};

  for (const dimension of definition.dimensions) {
    const expression = state.values[dimension.key];
    if (!expression?.known || expression.value === undefined) continue;

    if (dimension.kind === "budget") {
      const amount = item.price?.amount;
      const requested = Number(expression.value);
      const within = amount !== undefined && Number.isFinite(requested) && amount <= requested;
      fitByDimension.push({
        dimension: dimension.key,
        status: amount === undefined ? "unknown" : within ? "match" : "miss",
        evidence:
          amount === undefined
            ? "price not specified"
            : `$${amount} vs $${requested} ${expression.strength ?? "target"}`,
      });
      if (within) score += priority === "price" ? 8 : 4;
      else if (expression.strength === "hard") {
        hardFailures.push({
          dimension: dimension.key,
          requested,
          actual: amount,
        });
      } else {
        score -= 2;
      }
      continue;
    }

    if (dimension.kind === "priority") {
      // Priority affects scoring weights; it is not a hard catalog attribute.
      fitByDimension.push({
        dimension: dimension.key,
        status: "match",
        evidence: `priority=${expression.value}`,
      });
      continue;
    }

    if (dimension.kind === "evidence") {
      const values = itemValues(item, dimension.key);
      const required = expression.value.toLowerCase();
      const match =
        values.includes(required) ||
        itemValues(item, "features").some((value) => value.includes(required.replace(/_/g, "-")));
      fitByDimension.push({
        dimension: `evidence:${expression.value}`,
        status: match ? "match" : "miss",
        evidence: match ? "explicit catalog attribute" : "explicit catalog evidence absent",
      });
      if (match) score += 5;
      else {
        hardFailures.push({
          dimension: `evidence:${expression.value}`,
          requested: "explicit_catalog_evidence",
          actual: "not_specified",
        });
      }
      continue;
    }

    const values = itemValues(item, dimension.key);
    const requested = expression.value.toLowerCase();
    const match =
      values.includes(requested) ||
      values.some((value) => value.includes(requested) || requested.includes(value));
    fitByDimension.push({
      dimension: dimension.key,
      status: values.length === 0 ? "unknown" : match ? "match" : "miss",
      evidence: values.length ? `catalog: ${values.join(", ")}` : "not specified",
    });
    if (match) {
      const boost = priority ? (priorityWeights[priority] ?? 0) : 0;
      score += dimension.kind === "enum" ? 6 + boost : 3 + boost;
    } else if (expression.strength === "hard") {
      hardFailures.push({
        dimension: dimension.key,
        requested: expression.value,
        actual: values,
      });
    }
  }

  if (priority === "price" && item.price?.amount !== undefined) {
    score += Math.max(0, 5 - item.price.amount / 50);
  }

  return {
    item,
    score: Number(score.toFixed(2)),
    hardFailures,
    fitByDimension,
  };
}

function detailUrl(
  origin: string,
  detailPath: string,
  itemId: string,
  searchId: string,
  position: string | number,
): string {
  const url = new URL(detailPath, origin.endsWith("/") ? origin : `${origin}/`);
  url.searchParams.set("item_id", itemId);
  url.searchParams.set("search_id", searchId);
  url.searchParams.set("position", String(position));
  return url.toString();
}

function serializeMatch(
  origin: string,
  detailPath: string,
  searchId: string,
  entry: RankedItem,
  position: string | number,
): RecordedMatch {
  return {
    itemId: entry.item.id,
    title: entry.item.title,
    brand: entry.item.brand,
    price: entry.item.price
      ? {
          amount: entry.item.price.amount,
          currency: entry.item.price.currency ?? "USD",
        }
      : undefined,
    catalogAttributes: {
      ...(entry.item.attributes ?? {}),
      ...(entry.item.matches ?? {}),
    },
    utilityScore: entry.score,
    fitByDimension: entry.fitByDimension,
    violatedHardConstraints: entry.hardFailures,
    detailUrl: detailUrl(origin, detailPath, entry.item.id, searchId, position),
  };
}

function buildCounterfactuals(
  origin: string,
  detailPath: string,
  searchId: string,
  state: NeedState,
  evaluated: RankedItem[],
  exactCount: number,
): RecordedCounterfactual[] {
  if (exactCount > 0) return [];
  const counterfactuals: RecordedCounterfactual[] = [];

  const budget = state.values.budget;
  if (budget?.known && budget.strength === "hard" && budget.value) {
    const ceiling = Number(budget.value);
    const cheapestOver = evaluated
      .filter(
        (entry) => entry.item.price?.amount !== undefined && entry.item.price.amount > ceiling,
      )
      .sort((a, b) => (a.item.price?.amount ?? 0) - (b.item.price?.amount ?? 0))[0];
    if (cheapestOver?.item.price) {
      counterfactuals.push({
        change: `raise_budget_from_${ceiling}_to_${cheapestOver.item.price.amount}`,
        effect: `${cheapestOver.item.title} becomes budget-eligible`,
        delta: cheapestOver.item.price.amount - ceiling,
        detailUrl: detailUrl(
          origin,
          detailPath,
          cheapestOver.item.id,
          searchId,
          "counterfactual-budget",
        ),
      });
    }
  }

  const color = state.values.color;
  if (color?.known && color.strength === "hard" && color.value) {
    const bestColorMiss = evaluated.find((entry) =>
      entry.hardFailures.some((failure) => failure.dimension === "color"),
    );
    if (bestColorMiss) {
      counterfactuals.push({
        change: `treat_${color.value}_as_preference_instead_of_requirement`,
        effect: `${bestColorMiss.item.title} becomes eligible`,
        detailUrl: detailUrl(
          origin,
          detailPath,
          bestColorMiss.item.id,
          searchId,
          "counterfactual-color",
        ),
      });
    }
  }

  return counterfactuals;
}

export function parseDomainNeedTokens<State>(
  domain: AgentExperienceDomain<State>,
  tokens: string[],
): ParsedDomainNeed<State> {
  const state = domain.initialState();
  const invalidTokens: string[] = [];
  for (const token of tokens) {
    if (!isValidNeedToken(token) || !domain.applyToken(state, token)) {
      invalidTokens.push(token);
    }
  }
  return { state, invalidTokens };
}

function domainNegotiationUrl(
  domain: AgentExperienceDomain<unknown>,
  origin: string,
  journeyId: string,
  tokens: string[],
): string {
  const base = `${origin.replace(/\/$/, "")}/agent-negotiate/${journeyId}/${domain.slug}`;
  return tokens.length ? `${base}/${tokens.join("/")}` : base;
}

function domainDecisionUrl(
  domain: AgentExperienceDomain<unknown>,
  origin: string,
  journeyId: string,
  tokens: string[],
): string {
  const base = `${origin.replace(/\/$/, "")}/agent-decide/${journeyId}/${domain.slug}`;
  return tokens.length ? `${base}/${tokens.join("/")}` : base;
}

function domainItemUrl(
  domain: AgentExperienceDomain<unknown>,
  origin: string,
  itemId: string,
  searchId: string,
  position: string | number,
): string {
  const url = new URL(
    `/agent-item/${domain.slug}/${encodeURIComponent(itemId)}`,
    origin.endsWith("/") ? origin : `${origin}/`,
  );
  url.searchParams.set("search_id", searchId);
  url.searchParams.set("position", String(position));
  return url.toString();
}

function checkedDomainChoiceUrl(base: string, choice: ExperienceChoice): ExperienceChoiceLink {
  if (!isValidNeedToken(choice.token)) {
    throw new Error(`Domain choice token "${choice.token}" is not a valid need token.`);
  }
  return {
    value: choice.value,
    meaning: choice.meaning,
    token: choice.token,
    url: append(base, choice.token),
    strength: choice.strength,
  };
}

export function buildDomainNegotiationNode<State>(
  domain: AgentExperienceDomain<State>,
  origin: string,
  journeyId: string,
  tokens: string[],
) {
  if (!isValidJourneyId(journeyId)) {
    throw new Error("journeyId must look like j-<id>");
  }
  const parsed = parseDomainNeedTokens(domain, tokens);
  const domainForUrl = domain as AgentExperienceDomain<unknown>;
  const base = domainNegotiationUrl(domainForUrl, origin, journeyId, tokens);
  const decisionReady = domain.hasDecisionInput(parsed.state);
  const resultsUrl = decisionReady
    ? domainDecisionUrl(domainForUrl, origin, journeyId, tokens)
    : null;
  const question = domain.nextQuestion(parsed.state);

  return {
    protocol: AGENT_EXPERIENCE_PROTOCOLS.negotiation,
    domain: domain.slug,
    merchant: domain.brand,
    stage: !decisionReady
      ? ("decision_input_required" as const)
      : question
        ? ("express_more_or_decide" as const)
        : ("ready_to_decide" as const),
    journeyId,
    needState: domain.publicState(parsed.state),
    invalidTokens: parsed.invalidTokens,
    disclosureModel: {
      principle: "Share only task-relevant values that improve this recommendation.",
      acceptedProvenance: [
        "current_user_request",
        "user_confirmed",
        "agent_inference_from_current_task",
      ],
      memoryOnlyValues:
        "Do not supply a long-term-memory value unless it is independently relevant to the current task.",
    },
    traversalRule:
      "Open exactly one URL supplied by the current response. Never construct, edit, or combine path segments. The next response preserves prior state and supplies the next exact links.",
    nextQuestion: question
      ? {
          dimension: question.dimension,
          question: question.question,
          whyItMatters: question.whyItMatters,
          choices: question.choices.map((choice) => checkedDomainChoiceUrl(base, choice)),
          ...(question.unknownToken
            ? {
                unknownUrl: isValidNeedToken(question.unknownToken)
                  ? append(base, question.unknownToken)
                  : (() => {
                      throw new Error(
                        `Domain unknown token "${question.unknownToken}" is not a valid need token.`,
                      );
                    })(),
              }
            : {}),
          ...(resultsUrl ? { skipUrl: resultsUrl } : {}),
        }
      : null,
    availableNeedEdges: domain.edgeGroups(parsed.state).map((group) => ({
      dimension: group.dimension,
      whyItMatters: group.whyItMatters,
      choices: group.choices.map((choice) => checkedDomainChoiceUrl(base, choice)),
    })),
    resultsUrl,
    sufficiency: decisionReady
      ? {
          sufficientForResults: true,
          note: "Add more known inputs only when they materially improve this recommendation.",
        }
      : {
          sufficientForResults: false,
          note: "Choose one known task-relevant edge. If none is known, clarify the need with the user.",
        },
    operation: `/agent-negotiate/${domain.slug}`,
  };
}

export function buildDomainDecisionNode<State>(
  domain: AgentExperienceDomain<State>,
  origin: string,
  journeyId: string,
  tokens: string[],
  searchId = cryptoRandomId(),
) {
  if (!isValidJourneyId(journeyId)) {
    throw new Error("journeyId must look like j-<id>");
  }
  const parsed = parseDomainNeedTokens(domain, tokens);
  const domainForUrl = domain as AgentExperienceDomain<unknown>;
  if (!domain.hasDecisionInput(parsed.state)) {
    return {
      protocol: AGENT_EXPERIENCE_PROTOCOLS.decision,
      error: "decision_input_required" as const,
      message:
        "At least one task-relevant constraint, preference, purpose, or priority is required before results can be ranked.",
      journeyId,
      domain: domain.slug,
      merchant: domain.brand,
      needState: domain.publicState(parsed.state),
      invalidTokens: parsed.invalidTokens,
      negotiateUrl: domainNegotiationUrl(domainForUrl, origin, journeyId, tokens),
      operation: `/agent-decide/${domain.slug}`,
    };
  }

  const evaluation = domain.evaluate(parsed.state);
  const allEvaluated = [...evaluation.exact, ...evaluation.nearMisses];
  const seen = new Set<string>();
  const uniqueEvaluated = allEvaluated.filter((entry) => {
    if (seen.has(entry.itemId)) return false;
    seen.add(entry.itemId);
    return true;
  });
  const exact = uniqueEvaluated.filter((entry) => entry.violatedHardConstraints.length === 0);
  const nearMisses = uniqueEvaluated.filter((entry) => entry.violatedHardConstraints.length > 0);
  const records = new Map(domain.catalog.map((record) => [record.id, record]));
  const serialize = (entry: ExperienceEvaluatedItem, position: string | number) => {
    const record = records.get(entry.itemId);
    return {
      itemId: entry.itemId,
      title: record?.title ?? entry.itemId,
      brand: record?.brand ?? domain.brand,
      price: record?.price,
      summary: record?.summary ?? "",
      catalogAttributes: record?.attributes ?? {},
      utilityScore: entry.utilityScore,
      fitByDimension: entry.fitByDimension,
      violatedHardConstraints: entry.violatedHardConstraints,
      detailUrl: domainItemUrl(domainForUrl, origin, entry.itemId, searchId, position),
    };
  };

  return {
    protocol: AGENT_EXPERIENCE_PROTOCOLS.decision,
    stage: "decision_support" as const,
    journeyId,
    domain: domain.slug,
    merchant: domain.brand,
    searchId,
    needState: domain.publicState(parsed.state),
    invalidTokens: parsed.invalidTokens,
    exactMatchCount: exact.length,
    exactMatches: exact.map((entry, index) => serialize(entry, index + 1)),
    nearMissCount: nearMisses.length,
    nearMisses: nearMisses.map((entry, index) => serialize(entry, `near-${index + 1}`)),
    counterfactuals:
      exact.length === 0 && nearMisses.length > 0
        ? evaluation.counterfactuals.map((counterfactual, index) => ({
            change: counterfactual.change,
            effect: counterfactual.effect,
            ...(counterfactual.deltaUsd !== undefined ? { deltaUsd: counterfactual.deltaUsd } : {}),
            ...(counterfactual.itemId
              ? {
                  detailUrl: domainItemUrl(
                    domainForUrl,
                    origin,
                    counterfactual.itemId,
                    searchId,
                    `counterfactual-${index + 1}`,
                  ),
                }
              : {}),
          }))
        : [],
    operation: `/agent-decide/${domain.slug}`,
  };
}

export function buildDomainItemNode<State>(
  domain: AgentExperienceDomain<State>,
  origin: string,
  itemId: string,
  searchId: string | null = null,
  position: string | number | null = null,
) {
  const record = domain.catalog.find((candidate) => candidate.id === itemId);
  if (!record) return null;
  const positionValue =
    position !== null && /^\d+$/.test(String(position)) ? Number(position) : position;

  return {
    protocol: AGENT_EXPERIENCE_PROTOCOLS.item,
    domain: domain.slug,
    merchant: domain.brand,
    itemId: record.id,
    searchAttribution: searchId ? { searchId, resultPosition: positionValue } : null,
    catalog: {
      provenance: "merchant_catalog" as const,
      title: record.title,
      brand: record.brand,
      category: record.category,
      price: record.price,
      summary: record.summary,
      attributes: record.attributes,
      notSpecified: record.notSpecified,
    },
    sellerClaims: record.sellerClaims,
    navigation: {
      searchGuide: `${origin.replace(/\/$/, "")}/`,
      negotiate: `${origin.replace(/\/$/, "")}/agent-negotiate/j-${cryptoRandomId()}/${domain.slug}`,
    },
    operation: `/agent-item/${domain.slug}`,
  };
}

export function createExperienceGraph(definition: ExperienceGraphDefinition) {
  if (!definition.category || !TOKEN_RE.test(snake(definition.category))) {
    throw new Error("category must be a lowercase slug");
  }
  if (!definition.dimensions.length) {
    throw new Error("dimensions must contain at least one entry");
  }
  if (!definition.items.length) {
    throw new Error("items must contain at least one entry");
  }

  const category =
    snake(definition.category).replace(/-/g, "_") === definition.category
      ? definition.category
      : snake(definition.category);

  const normalized: ExperienceGraphDefinition = {
    ...definition,
    category,
    protocol: definition.protocol ?? "epode-agent-experience/1.0",
  };

  function negotiatePath(
    origin: string,
    journeyId: string,
    tokens: string[],
    paths: ExperienceGraphPaths,
  ): string {
    const prefix = paths.negotiatePrefix ?? "/agent-negotiate";
    const base = `${origin.replace(/\/$/, "")}${prefix}/${journeyId}/${normalized.category}`;
    return tokens.length ? `${base}/${tokens.join("/")}` : base;
  }

  function decidePath(
    origin: string,
    journeyId: string,
    tokens: string[],
    paths: ExperienceGraphPaths,
  ): string {
    const prefix = paths.decidePrefix ?? "/agent-decide";
    const base = `${origin.replace(/\/$/, "")}${prefix}/${journeyId}/${normalized.category}`;
    return tokens.length ? `${base}/${tokens.join("/")}` : base;
  }

  function buildGuide(origin: string, journeyId: string, paths: ExperienceGraphPaths = {}) {
    const lampUrl = negotiatePath(origin, journeyId, [], paths);
    return [
      "# Agent experience guide",
      "",
      "The definitive entry point for agents is the machine-readable need negotiation graph.",
      "",
      "Open the exact category URL that matches the current request:",
      `- ${normalized.category}: ${lampUrl}`,
      "",
      "- Each response carries the current need state and concrete, task-relevant edges.",
      "- At least one known decision input is required before ranked results.",
      "- Open exactly one supplied URL at a time. Never construct, edit, or combine path segments.",
      "- Share only current-task values that improve this recommendation.",
      "- Results separate exact matches from near misses and expose counterfactuals only on zero exact matches.",
      "- Results provide ordinary detail_url links. Open a detail URL only for a result you evaluate closely.",
    ].join("\n");
  }

  function buildNegotiation(options: ExperienceGraphOptions): NegotiationNode {
    if (!isValidJourneyId(options.journeyId)) {
      throw new Error("journeyId must look like j-<id>");
    }
    const tokens = options.tokens ?? [];
    const paths = options.paths ?? {};
    const parsed = parseNeedTokens(normalized, tokens);
    const base = negotiatePath(options.origin, options.journeyId, tokens, paths);
    const decisionReady = hasDecisionInput(normalized, parsed.state);
    const resultsUrl = decisionReady
      ? decidePath(options.origin, options.journeyId, tokens, paths)
      : null;
    const question = nextQuestion(normalized, base, resultsUrl, parsed.state);
    const stage = !decisionReady
      ? "decision_input_required"
      : question
        ? "express_more_or_decide"
        : "ready_to_decide";

    return {
      protocol: `${normalized.protocol}-negotiation`,
      stage,
      journeyId: options.journeyId,
      category: normalized.category,
      needState: parsed.state,
      invalidTokens: parsed.invalidTokens,
      disclosureModel: {
        principle: "Share only task-relevant values that improve this recommendation.",
        acceptedProvenance: [
          "current_user_request",
          "user_confirmed",
          "agent_inference_from_current_task",
        ],
        memoryOnlyValues:
          "Do not supply a long-term-memory value unless it is independently relevant to the current task.",
      },
      traversalRule:
        "Open exactly one URL supplied by the current response. Never construct, edit, or combine path segments. The next response preserves prior state and supplies the next exact links.",
      nextQuestion: question,
      availableNeedEdges: availableNeedEdges(normalized, base, parsed.state),
      resultsUrl,
      sufficiency: decisionReady
        ? {
            sufficientForResults: true,
            note: "Add more known inputs only when they materially improve this recommendation.",
          }
        : {
            sufficientForResults: false,
            note: "Choose one known task-relevant edge. If none is known, clarify the need with the user.",
          },
      operation: `/agent-negotiate/${normalized.category}`,
    };
  }

  function buildDecision(options: ExperienceGraphOptions): DecisionNode {
    if (!isValidJourneyId(options.journeyId)) {
      throw new Error("journeyId must look like j-<id>");
    }
    const tokens = options.tokens ?? [];
    const paths = options.paths ?? {};
    const parsed = parseNeedTokens(normalized, tokens);
    const decisionReady = hasDecisionInput(normalized, parsed.state);
    if (!decisionReady) {
      return {
        protocol: `${normalized.protocol}-decision`,
        error: "decision_input_required",
        message:
          "At least one task-relevant constraint, preference, purpose, or priority is required before catalog results can be ranked.",
        journeyId: options.journeyId,
        category: normalized.category,
        needState: parsed.state,
        invalidTokens: parsed.invalidTokens,
        negotiateUrl: negotiatePath(options.origin, options.journeyId, tokens, paths),
        operation: `/agent-decide/${normalized.category}`,
      };
    }

    const searchId = options.searchId ?? cryptoRandomId();
    const detailPath = paths.detailPath ?? "/agent-item";
    const evaluated = normalized.items
      .map((item) => evaluateItem(normalized, item, parsed.state))
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.item.price?.amount ?? Number.POSITIVE_INFINITY) -
            (b.item.price?.amount ?? Number.POSITIVE_INFINITY),
      );
    const exact = evaluated.filter((entry) => entry.hardFailures.length === 0);
    const near = evaluated.filter((entry) => entry.hardFailures.length > 0);

    return {
      protocol: `${normalized.protocol}-decision`,
      stage: "decision_support",
      journeyId: options.journeyId,
      category: normalized.category,
      searchId,
      needState: parsed.state,
      invalidTokens: parsed.invalidTokens,
      exactMatchCount: exact.length,
      exactMatches: exact.map((entry, index) =>
        serializeMatch(options.origin, detailPath, searchId, entry, index + 1),
      ),
      nearMissCount: near.length,
      nearMisses: near.map((entry, index) =>
        serializeMatch(options.origin, detailPath, searchId, entry, `near-${index + 1}`),
      ),
      counterfactuals: buildCounterfactuals(
        options.origin,
        detailPath,
        searchId,
        parsed.state,
        evaluated,
        exact.length,
      ),
      operation: `/agent-decide/${normalized.category}`,
    };
  }

  function itemDetail(itemId: string, searchId?: string, position?: string | number) {
    const item = normalized.items.find((entry) => entry.id === itemId);
    if (!item) {
      return {
        protocol: `${normalized.protocol}-item`,
        error: "item_not_found",
        requestedItemId: itemId,
        available: normalized.items.map((entry) => entry.id),
      };
    }
    return {
      protocol: `${normalized.protocol}-item`,
      itemId: item.id,
      searchAttribution: searchId
        ? {
            searchId,
            resultPosition:
              position === undefined
                ? null
                : Number.isFinite(Number(position))
                  ? Number(position)
                  : String(position),
          }
        : null,
      catalog: {
        provenance: "merchant_catalog",
        title: item.title,
        brand: item.brand,
        category: item.category ?? normalized.category,
        price: item.price
          ? { amount: item.price.amount, currency: item.price.currency ?? "USD" }
          : undefined,
        attributes: item.attributes ?? {},
        matches: item.matches ?? {},
      },
      sellerClaims: [],
      notSpecified: [],
      operation: "/agent-item",
    };
  }

  return {
    definition: normalized,
    buildGuide,
    buildNegotiation,
    buildDecision,
    itemDetail,
    parseNeedTokens: (tokens: string[]) => parseNeedTokens(normalized, tokens),
    hasDecisionInput: (state: NeedState) => hasDecisionInput(normalized, state),
  };
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Which surface of the same experience graph a hop traversed: the faceted
 * HTML-link storefront that chat-mode assistants follow, or the tokened
 * native JSON graph that API-capable agents walk.
 */
export type ExperienceChannel = "faceted_html" | "native_graph";

/**
 * Aggregate-safe hop evidence carried on telemetry events. Dimension keys and
 * decision-quality numbers only — never free-text customer or agent values.
 */
export interface ExperienceTelemetry {
  channel?: ExperienceChannel;
  stage?: string;
  needState?: {
    expressedDimensions?: string[];
    unknownDimensions?: string[];
  };
  decision?: {
    exactMatchCount?: number;
    nearMissCount?: number;
    violatedHardConstraints?: Array<{
      dimension: string;
      requested?: string;
      actual?: string;
      itemId?: string;
    }>;
    counterfactuals?: Array<{ change: string; delta?: number; itemId?: string }>;
  };
  search?: { searchId?: string; resultPosition?: number };
}

const EXPERIENCE_DIMENSION_LIMIT = 24;
const EXPERIENCE_VIOLATION_LIMIT = 40;
const EXPERIENCE_COUNTERFACTUAL_LIMIT = 8;
const EXPERIENCE_COUNT_LIMIT = 100_000;

/** Code-point-safe truncation: a byte-index slice could split a surrogate pair. */
function boundedText(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function boundedValueText(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text ? boundedText(text, limit) : undefined;
}

function boundedCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return Math.min(value, EXPERIENCE_COUNT_LIMIT);
}

const EXPERIENCE_CHANNELS: readonly ExperienceChannel[] = ["faceted_html", "native_graph"];

/**
 * Derive the aggregate-safe experience payload from a built graph node. Accepts
 * negotiation, decision, item, and product-node shapes from both the token and
 * programmable-domain builders; unrecognized shapes yield undefined unless a
 * `channel` option marks the hop. Pass `channel: "faceted_html"` for hops the
 * agent reached through faceted HTML links and `channel: "native_graph"` for
 * tokened JSON graph paths.
 */
export function experienceTelemetryForNode(
  node: unknown,
  options?: { channel?: ExperienceChannel },
): ExperienceTelemetry | undefined {
  const experience: ExperienceTelemetry = {};
  if (options?.channel && EXPERIENCE_CHANNELS.includes(options.channel)) {
    experience.channel = options.channel;
  }
  if (typeof node !== "object" || node === null) {
    return Object.keys(experience).length ? experience : undefined;
  }
  const source = node as {
    stage?: unknown;
    needState?: NeedState;
    exactMatchCount?: unknown;
    nearMissCount?: unknown;
    nearMisses?: RecordedMatch[];
    counterfactuals?: Array<RecordedCounterfactual & { deltaUsd?: number }>;
    searchAttribution?: { searchId?: unknown; resultPosition?: unknown } | null;
  };
  if (typeof source.stage === "string" && source.stage) {
    experience.stage = boundedText(source.stage, 40);
  }

  if (source.needState && Array.isArray(source.needState.expressedDimensions)) {
    const expressed = source.needState.expressedDimensions
      .filter((dimension) => typeof dimension === "string" && !dimension.endsWith("_unknown"))
      .slice(0, EXPERIENCE_DIMENSION_LIMIT)
      .map((dimension) => boundedText(dimension, 80));
    const unknown = Object.entries(source.needState.values ?? {})
      .filter(([, value]) => value?.known === false)
      .map(([dimension]) => boundedText(dimension, 80))
      .slice(0, EXPERIENCE_DIMENSION_LIMIT);
    if (expressed.length || unknown.length) {
      experience.needState = {
        ...(expressed.length ? { expressedDimensions: expressed } : {}),
        ...(unknown.length ? { unknownDimensions: unknown } : {}),
      };
    }
  }

  if (typeof source.exactMatchCount === "number" || typeof source.nearMissCount === "number") {
    const violations = (source.nearMisses ?? [])
      .flatMap((match) =>
        (match.violatedHardConstraints ?? []).map((violation) => ({
          dimension: boundedText(String(violation.dimension), 80),
          requested: boundedValueText(violation.requested, 120),
          actual: boundedValueText(violation.actual, 120),
          itemId: match.itemId ? boundedText(String(match.itemId), 120) : undefined,
        })),
      )
      .slice(0, EXPERIENCE_VIOLATION_LIMIT);
    const counterfactuals = (source.counterfactuals ?? [])
      .slice(0, EXPERIENCE_COUNTERFACTUAL_LIMIT)
      .map((counterfactual) => {
        // The domain builder emits `deltaUsd`; the token builder emits `delta`.
        const delta = counterfactual.delta ?? counterfactual.deltaUsd;
        return {
          change: boundedText(String(counterfactual.change), 160),
          ...(typeof delta === "number" && Number.isFinite(delta) ? { delta } : {}),
        };
      });
    const exactMatchCount = boundedCount(source.exactMatchCount);
    const nearMissCount = boundedCount(source.nearMissCount);
    experience.decision = {
      ...(exactMatchCount === undefined ? {} : { exactMatchCount }),
      ...(nearMissCount === undefined ? {} : { nearMissCount }),
      ...(violations.length ? { violatedHardConstraints: violations } : {}),
      ...(counterfactuals.length ? { counterfactuals } : {}),
    };
  }

  if (source.searchAttribution && typeof source.searchAttribution === "object") {
    const { searchId, resultPosition } = source.searchAttribution;
    const position = Number(resultPosition);
    const search = {
      ...(typeof searchId === "string" && searchId ? { searchId: searchId.slice(0, 120) } : {}),
      ...(Number.isInteger(position) && position >= 1 && position <= EXPERIENCE_COUNT_LIMIT
        ? { resultPosition: position }
        : {}),
    };
    if (Object.keys(search).length) experience.search = search;
  }

  return Object.keys(experience).length ? experience : undefined;
}

/**
 * Map a negotiation/decision hop onto Epode telemetry fields. Need state and
 * decision quality travel in the aggregate-safe `experience` payload; raw
 * customer values remain in the product response only.
 */
export function experienceTelemetryDetails(input: {
  operation: string;
  journeyId: string;
  statusCode?: number;
  durationMs?: number;
  runtimeHint?: string;
  experience?: ExperienceTelemetry;
}): {
  surface: "http_json";
  operation: string;
  statusCode: number;
  durationMs?: number;
  classification: "unclassified";
  runtimeHint?: string;
  runtimeHintSource?: "http";
  sessionRef: string;
  sessionSource: "customer";
  experience?: ExperienceTelemetry;
} {
  return {
    surface: "http_json",
    operation: input.operation.slice(0, 160),
    statusCode: input.statusCode ?? 200,
    durationMs: input.durationMs,
    classification: "unclassified",
    runtimeHint: input.runtimeHint,
    runtimeHintSource: input.runtimeHint ? "http" : undefined,
    sessionRef: input.journeyId.slice(0, 160),
    sessionSource: "customer",
    experience: input.experience,
  };
}

/**
 * Report a human navigation through a product-generated session link. The
 * first-party browser reference is identity evidence; request IP and
 * user-agent values remain observations and are never identity.
 */
export function productLinkClickTelemetryDetails(input: {
  operation: string;
  sessionRef: string;
  anonymousRef: string;
  requestObservation?: {
    clientIp?: string;
    method?: string;
    userAgent?: string;
    acceptLanguage?: string;
    referrerOrigin?: string;
    secChUa?: string;
    secChUaPlatform?: string;
    secChUaMobile?: string;
  };
  statusCode?: number;
  durationMs?: number;
  runtimeHint?: string;
  experience?: ExperienceTelemetry;
}) {
  return {
    surface: "http_html" as const,
    operation: input.operation.slice(0, 160),
    statusCode: input.statusCode ?? 200,
    durationMs: input.durationMs,
    anonymousRef: input.anonymousRef.slice(0, 160),
    customerLinkSource: "product_link_click" as const,
    requestObservation: input.requestObservation,
    classification: "unclassified" as const,
    runtimeHint: input.runtimeHint,
    runtimeHintSource: input.runtimeHint ? ("http" as const) : undefined,
    sessionRef: input.sessionRef.slice(0, 160),
    sessionSource: "customer" as const,
    experience: input.experience,
  };
}

export function createLightingExperienceCatalog(): ExperienceGraphDefinition {
  return {
    protocol: "epode-agent-experience/1.0",
    category: "lamp",
    priorityWeights: {
      functional_fit: 4,
      appearance: 2,
      price: 0,
      portability: 2,
      serviceability: 2,
    },
    dimensions: [
      {
        key: "budget",
        kind: "budget",
        question: "What budget value and strength are known for this purchase?",
        whyItMatters: "A hard ceiling excludes products; a target permits an explicit tradeoff.",
        anchorMeaning: "A budget ceiling or target is known",
        choices: [150, 175, 200, 250, 300].flatMap((amount) => [
          {
            token: `budget-hard-${amount}`,
            value: String(amount),
            meaning: `$${amount} absolute maximum`,
            strength: "hard" as const,
          },
          {
            token: `budget-target-${amount}`,
            value: String(amount),
            meaning: `$${amount} preferred target`,
            strength: "target" as const,
          },
        ]),
      },
      {
        key: "purpose",
        kind: "enum",
        question: "What will the lamp be used for?",
        whyItMatters: "Purpose maps to concrete functional catalog evidence.",
        anchorMeaning: "The intended use is known",
        allowUnknown: true,
        choices: [
          "coding",
          "reading",
          "writing",
          "watching_tv",
          "drawing",
          "photography",
          "conversation",
          "precision_tasks",
          "studying",
          "relaxing",
        ].map((value) => ({
          token: `purpose-${value.replace(/_/g, "-")}`,
          value,
          meaning: `Optimize for ${value.replace(/_/g, " ")}`,
          strength: "hard" as const,
        })),
      },
      {
        key: "color",
        kind: "enum",
        question: "What color value and strength are known for this purchase?",
        whyItMatters: "Strength distinguishes an exclusion rule from a tie-breaker.",
        anchorMeaning: "A color requirement or preference is known",
        choices: ["orange", "neutral", "black", "white"].flatMap((color) => [
          {
            token: `color-require-${color}`,
            value: color,
            meaning: `Exclude products without ${color}`,
            strength: "hard" as const,
          },
          {
            token: `color-prefer-${color}`,
            value: color,
            meaning: `Prefer ${color}; allow better functional fits`,
            strength: "preference" as const,
          },
        ]),
      },
      {
        key: "priority",
        kind: "priority",
        question: "Which criterion should dominate ranking?",
        whyItMatters: "Priority resolves tradeoffs between otherwise similar matches.",
        anchorMeaning: "The dominant ranking criterion is known",
        optional: true,
        choices: (
          [
            ["functional_fit", "functional-fit", "Functional fit"],
            ["price", "price", "Lowest total price"],
            ["appearance", "appearance", "Color and style"],
            ["portability", "portability", "Portability"],
            ["serviceability", "serviceability", "Repairability"],
          ] as const
        ).map(([value, token, meaning]) => ({
          token: `priority-${token}`,
          value,
          meaning,
        })),
      },
      {
        key: "evidence",
        kind: "evidence",
        question: "Should a functional claim require explicit catalog evidence?",
        whyItMatters:
          "Evidence thresholds stop seller language from masquerading as functional proof.",
        anchorMeaning: "An evidence threshold is known",
        optional: true,
        choices: [
          {
            token: "evidence-glare-control",
            value: "glare_control",
            meaning: "Require explicit catalog glare-control evidence",
            strength: "hard",
          },
        ],
      },
    ],
    items: [
      {
        id: "forma-one-table-lamp",
        title: "Forma One Table Lamp",
        brand: "Fieldnote",
        category: "lighting",
        price: { amount: 248, currency: "USD" },
        attributes: {
          features: ["dimmable", "warm-white LED", "soft light"],
          styles: ["warm minimal", "sculptural"],
        },
        matches: {
          color: ["rust red", "orange", "warm cream", "soft black"],
          purpose: ["watching_tv", "reading", "relaxing", "bedside"],
          brand: ["fieldnote"],
        },
      },
      {
        id: "halo-portable-lamp",
        title: "Halo Portable Lamp",
        brand: "Northstar",
        category: "lighting",
        price: { amount: 164, currency: "USD" },
        attributes: {
          features: ["portable", "warm light", "soft light"],
        },
        matches: {
          color: ["warm cream", "sage"],
          purpose: ["watching_tv", "relaxing", "conversation", "outdoor"],
          brand: ["northstar"],
        },
      },
      {
        id: "arc-mini-task-lamp",
        title: "Arc Mini Task Lamp",
        brand: "Fieldnote",
        category: "lighting",
        price: { amount: 185, currency: "USD" },
        attributes: {
          features: ["adjustable", "focused light", "replaceable bulb"],
        },
        matches: {
          color: ["soft black", "sand"],
          purpose: ["coding", "writing", "reading", "studying"],
          brand: ["fieldnote"],
        },
      },
      {
        id: "focus-grid-desk-lamp",
        title: "Focus Grid Desk Lamp",
        brand: "Northstar",
        category: "lighting",
        price: { amount: 129, currency: "USD" },
        attributes: {
          features: ["adjustable", "glare-controlled", "focused light", "USB-C charging"],
        },
        matches: {
          color: ["orange", "graphite", "warm white"],
          purpose: ["coding", "writing", "reading", "studying"],
          brand: ["northstar"],
          evidence: ["glare_control"],
        },
      },
      {
        id: "chroma-studio-lamp",
        title: "Chroma Studio Lamp",
        brand: "Prism Works",
        category: "lighting",
        price: { amount: 142, currency: "USD" },
        attributes: {
          features: ["high CRI 95", "color accurate", "adjustable", "dimmable"],
        },
        matches: {
          color: ["safety orange", "white", "graphite"],
          purpose: ["drawing", "photography", "color_work"],
          brand: ["prism works"],
        },
      },
      {
        id: "draftline-architect-lamp",
        title: "Draftline Architect Lamp",
        brand: "Fieldnote",
        category: "lighting",
        price: { amount: 149, currency: "USD" },
        attributes: {
          features: ["wide task light", "adjustable", "high CRI 90", "replaceable bulb"],
        },
        matches: {
          color: ["rust orange", "soft black", "sand"],
          purpose: ["drawing", "precision_tasks", "color_work"],
          brand: ["fieldnote"],
        },
      },
      {
        id: "counsel-glow-lamp",
        title: "Counsel Glow Lamp",
        brand: "Northstar",
        category: "lighting",
        price: { amount: 138, currency: "USD" },
        attributes: {
          features: ["soft light", "warm light", "dimmable", "glare-controlled"],
        },
        matches: {
          color: ["warm cream", "sage", "clay"],
          purpose: ["conversation", "watching_tv", "relaxing"],
          brand: ["northstar"],
          evidence: ["glare_control"],
        },
      },
      {
        id: "shift-clinical-task-lamp",
        title: "Shift Clinical Task Lamp",
        brand: "Plain Works",
        category: "lighting",
        price: { amount: 146, currency: "USD" },
        attributes: {
          features: ["adjustable", "shadow-reducing", "easy-clean", "focused light"],
        },
        matches: {
          color: ["white", "soft gray"],
          purpose: ["precision_tasks", "inspection"],
          brand: ["plain works"],
        },
      },
    ],
  };
}
