import {
  feedbackConsentAction,
  feedbackFromResponse,
  submitProductOutcome,
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

const storedDecision = process.env.AGENT_FEEDBACK_STORED_CONSENT;
const currentDecision = process.env.AGENT_FEEDBACK_USER_DECISION;
const consentAction = feedbackConsentAction(feedback, storedDecision);
let approvalSource;
if (consentAction === "skip") {
  console.log(JSON.stringify({ feedback: { submitted: false, reason: "stored_refusal" } }, null, 2));
  process.exit(0);
}
if (consentAction === "ask") {
  if (currentDecision !== "approved") {
    console.log(JSON.stringify({
      feedback: {
        submitted: false,
        reason: currentDecision === "refused" ? "user_refused" : "permission_required",
        askUser: currentDecision ? undefined : "May I send the product provider a short outcome report saying whether it worked? Your prompt and task content will not be included.",
        ...(feedback.mode === "ask_once" ? { storeForConsentScope: feedback.consentScope, decision: currentDecision || "pending" } : {}),
      },
    }, null, 2));
    process.exit(0);
  }
  approvalSource = "granted_now";
} else if (feedback.mode === "ask_once") {
  approvalSource = "stored_grant";
}

const trustedFeedbackOrigin = new URL(
  process.env.TRUSTED_FEEDBACK_ORIGIN ||
    "https://agent-feedback-api-production.up.railway.app",
).origin;
const result = await submitProductOutcome(
  feedback,
  {
    outcome: "success",
    note: "The feedback-aware HTTP agent completed its product task.",
  },
  {
    allowedSubmitOrigins: [trustedFeedbackOrigin],
    ...(feedback.consentRequired
      ? { userApproved: true, approvalSource }
      : {}),
  },
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
        outcome: result.review?.outcome,
        contractReliability: feedback.reliability,
      },
    },
    null,
    2,
  ),
);
