import { ConfidenceLabel, ProvenanceBadge } from "@/components/dashboard/intelligence-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CustomerSignal } from "@/lib/api/customer-intelligence";
import { formatDate, titleCase } from "@/lib/dashboard/format";

export function SignalEvidenceList({
  signals,
  empty = "No customer signals in this view.",
  openFeature,
  openFeedback,
  openInteraction,
  openSession,
}: {
  signals: CustomerSignal[];
  empty?: string;
  openFeature?: (featureKey: string) => void;
  openFeedback?: (reportId: string) => void;
  openInteraction?: (interactionId: string) => void;
  openSession?: (sessionId: string) => void;
}) {
  if (!signals.length) return <p className="text-sm text-muted-foreground">{empty}</p>;

  return (
    <ol className="divide-y">
      {signals.map((signal) => {
        const featureKey = signal.featureKey;
        const feedbackReportId = signal.feedbackReportId;
        const sessionId = signal.sessionId;
        const interactionId = signal.interactionId;
        const inactive =
          signal.consentState === "revoked" ||
          signal.consentState === "expired" ||
          (signal.expiresAt !== null && new Date(signal.expiresAt).getTime() <= Date.now());
        return (
          <li key={signal.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{titleCase(signal.type)}</Badge>
              <ProvenanceBadge provenance={signal.provenance} />
              {inactive ? <Badge variant="outline">Inactive</Badge> : null}
            </div>
            <p className="mt-2 text-sm font-medium leading-5">{signal.summary}</p>
            {signal.detail ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{signal.detail}</p>
            ) : null}
            <p className="mt-2 text-[11px] text-muted-foreground">
              <ConfidenceLabel value={signal.confidence} /> · {formatDate(signal.collectedAt)}
              {signal.consentScope ? ` · ${titleCase(signal.consentScope)}` : ""}
            </p>
            {signal.provenance === "agent_inference" ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Inferred by an agent; not a confirmed user statement.
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-1">
              {featureKey && openFeature ? (
                <Button variant="link" size="xs" onClick={() => openFeature(featureKey)}>
                  Open feature
                </Button>
              ) : null}
              {feedbackReportId && openFeedback ? (
                <Button variant="link" size="xs" onClick={() => openFeedback(feedbackReportId)}>
                  Open report
                </Button>
              ) : null}
              {sessionId && openSession ? (
                <Button variant="link" size="xs" onClick={() => openSession(sessionId)}>
                  Open session
                </Button>
              ) : null}
              {interactionId && openInteraction ? (
                <Button variant="link" size="xs" onClick={() => openInteraction(interactionId)}>
                  Open interaction
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
