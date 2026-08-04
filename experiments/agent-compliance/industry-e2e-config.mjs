export const INDUSTRY_E2E_PRODUCTS = [
  {
    slug: "shopwise",
    productName: "Shopwise Retail Demo",
    actionTool: "search_catalog",
    query: { category: "running_shoes", maxPriceUsd: 150, fit: "wide" },
    rememberedItems: [
      item("shopping.priority", "preference", "quality"),
      item("shopping.budget_band", "constraint", "50_150", "agent_reports_current_task"),
      item("shopping.delivery_window", "constraint", "within_week"),
    ],
    followupItems: [item("shopping.sustainability", "preference", "high")],
    sessionItems: [item("shopping.budget_band", "constraint", "150_500")],
    rejectedItem: item("private.payment_profile", "constraint", "not_shared"),
    variant: "wide-quality-under-150",
  },
  {
    slug: "tripwise",
    productName: "Tripwise Travel Demo",
    actionTool: "search_stays",
    query: { destination: "lisbon", maxNightlyUsd: 240, minimumGuestRating: 4.5 },
    rememberedItems: [
      item("travel.stay_style", "preference", "quiet_boutique"),
      item("travel.location_priority", "preference", "central_walkable"),
      item("travel.room_priority", "preference", "reliable_wifi"),
    ],
    followupItems: [item("travel.stay_style", "preference", "full_service")],
    sessionItems: [item("travel.location_priority", "preference", "transit_access")],
    rejectedItem: item("private.travel_document", "constraint", "not_shared"),
    variant: "quiet-central-lisbon",
  },
  {
    slug: "ledgerwise",
    productName: "Ledgerwise Finance Demo",
    actionTool: "compare_savings_accounts",
    query: { goal: "emergency_fund", minimumApy: 4, maximumMonthlyFeeUsd: 0 },
    rememberedItems: [
      item("finance.explanation_style", "preference", "comparison_table"),
      item("finance.liquidity_preference", "preference", "same_day"),
      item("content.topic_depth", "preference", "practical"),
    ],
    followupItems: [item("finance.explanation_style", "preference", "concise")],
    sessionItems: [item("content.format", "preference", "short")],
    rejectedItem: item("private.financial_profile", "constraint", "not_shared"),
    variant: "liquid-no-fee-comparison",
  },
  {
    slug: "carewise",
    productName: "Carewise Healthcare Demo",
    actionTool: "find_care_options",
    query: { service: "primary_care", maximumWaitDays: 10, visitMode: "either" },
    rememberedItems: [
      item("care.communication_style", "preference", "plain_language"),
      item("care.visit_mode", "preference", "either"),
      item("care.appointment_timing", "preference", "weekday_morning"),
    ],
    followupItems: [item("care.communication_style", "preference", "step_by_step")],
    sessionItems: [item("care.visit_mode", "preference", "telehealth")],
    rejectedItem: item("private.clinical_profile", "constraint", "not_shared"),
    variant: "plain-language-morning-care",
  },
  {
    slug: "learnwise",
    productName: "Learnwise Education Demo",
    actionTool: "find_courses",
    query: { subject: "generative_ai", maxPriceUsd: 300, maximumWeeklyHours: 6 },
    rememberedItems: [
      item("education.learning_format", "preference", "project_based"),
      item("education.learning_level", "preference", "intermediate"),
      item("content.format", "preference", "interactive"),
    ],
    followupItems: [item("content.topic_depth", "preference", "expert")],
    sessionItems: [item("content.format", "preference", "short")],
    rejectedItem: item("private.student_record", "constraint", "not_shared"),
    variant: "project-based-intermediate",
  },
  {
    slug: "deploywise",
    productName: "Deploywise SaaS Demo",
    actionTool: "compare_platform_plans",
    query: { workload: "ai_inference", maxMonthlyUsd: 2000, minimumSupportTier: "business" },
    rememberedItems: [
      item("b2b.company_size", "constraint", "mid_market"),
      item("b2b.primary_goal", "intent", "integrate"),
      item("b2b.integration_priority", "preference", "reliability"),
    ],
    followupItems: [item("b2b.purchase_timeline", "intent", "this_quarter")],
    sessionItems: [item("b2b.integration_priority", "preference", "security")],
    rejectedItem: item("private.company_credential", "constraint", "not_shared"),
    variant: "reliable-mid-market",
  },
];

export function item(key, type, value, provenance = "agent_reports_user_statement") {
  return {
    key,
    type,
    value,
    summary: `${key.replaceAll(".", " ")}: ${value.replaceAll("_", " ")}`,
    provenance,
    confidence: provenance === "agent_inference" ? 0.72 : 1,
    remember: true,
  };
}

export function productBySlug(slug) {
  const product = INDUSTRY_E2E_PRODUCTS.find((candidate) => candidate.slug === slug);
  if (!product) throw new Error(`Unknown industry product: ${slug}`);
  return product;
}
