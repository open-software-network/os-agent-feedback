import type { FeedbackFinding } from "@/lib/api/dashboard";

export function reportFindings(report: { findings?: unknown }): FeedbackFinding[] {
  if (!Array.isArray(report.findings)) return [];
  return report.findings.filter(
    (finding): finding is FeedbackFinding => typeof finding === "object" && finding !== null,
  );
}
