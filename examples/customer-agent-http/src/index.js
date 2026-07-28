import {
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
        outcome: result.review?.outcome,
        contractReliability: feedback.reliability,
      },
    },
    null,
    2,
  ),
);
