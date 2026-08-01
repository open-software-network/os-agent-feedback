import {
  feedbackConsentAction,
  feedbackFromResponse,
  submitFeedbackConsent,
  submitProductFeedback,
} from "@agent-feedback/node/agent";

const productUrl = process.argv[2] || process.env.PRODUCT_URL;
if (!productUrl) {
  throw new Error(
    "Usage: npm start -- https://company.example/product-endpoint",
  );
}

const response = await fetch(productUrl, {
  headers: { accept: "application/json, text/html" },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Product returned HTTP ${response.status}`);

const contentType = response.headers.get("content-type") || "";
const body = contentType.includes("application/json")
  ? await response.json()
  : await response.text();

// The customer's agent performs its normal product task here. Agent Feedback
// does not inspect the prompt, product payload, or final answer.
const feedback = feedbackFromResponse(response, body);
if (!feedback) throw new Error("Product response did not include feedback metadata");

const currentDecision = process.env.AGENT_FEEDBACK_USER_DECISION;
if (currentDecision && !["approved", "declined"].includes(currentDecision)) {
  throw new Error("AGENT_FEEDBACK_USER_DECISION must be approved or declined");
}
const consentAction = feedbackConsentAction(feedback);
let reportContract = feedback;
if (consentAction === "ask") {
  if (!currentDecision) {
    console.log(JSON.stringify({
      feedback: {
        submitted: false,
        reason: "permission_required",
        askUser: feedback.requiredAction.question,
      },
    }, null, 2));
    process.exit(0);
  }
  const decision = await submitFeedbackConsent(
    feedback,
    currentDecision === "approved" ? "approved" : "declined",
    { allowedSubmitOrigins: [new URL(process.env.TRUSTED_FEEDBACK_ORIGIN || "https://app.epode.ai").origin] },
  );
  if (!decision.feedback) {
    console.log(JSON.stringify({ feedback: { submitted: false, reason: "user_declined" } }, null, 2));
    process.exit(0);
  }
  reportContract = decision.feedback;
}

const trustedFeedbackOrigin = new URL(
  process.env.TRUSTED_FEEDBACK_ORIGIN ||
    "https://app.epode.ai",
).origin;
const result = await submitProductFeedback(
  reportContract,
  {
    summary: "The feedback-aware HTTP agent completed its product task and verified the result.",
    impact: "helped",
    confidence: 0.96,
    findings: [{ kind: "strength", topic: "reliability", detail: "The product returned a usable result on the first attempt." }],
    workaround: { used: false },
  },
  { allowedSubmitOrigins: [trustedFeedbackOrigin] },
);

const safeProductBody =
  body && typeof body === "object" && !Array.isArray(body)
    ? Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== "_agentFeedback"),
      )
    : typeof body === "string"
      ? body.replace(
          /<script[^>]+id=["']agent-feedback["'][^>]*>[\s\S]*?<\/script>/i,
          "<!-- scoped feedback contract consumed and redacted -->",
        )
      : body;

console.log(
  JSON.stringify(
    {
      productStatus: response.status,
      productBody: safeProductBody,
      feedback: {
        accepted: result.accepted,
        interactionId: result.interactionId,
        report: result.report,
        contractReliability: feedback.reliability,
      },
    },
    null,
    2,
  ),
);
