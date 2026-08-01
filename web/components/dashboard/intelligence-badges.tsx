import { Badge } from "@/components/ui/badge";
import { titleCase } from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";

const identityCopy: Record<string, string> = {
  verified: "Verified",
  pseudonymous: "Pseudonymous",
  ephemeral: "Ephemeral",
  unclassified: "Unresolved",
};

const provenanceCopy: Record<string, string> = {
  agent_reports_user_statement: "Agent reports user statement",
  agent_reports_current_task: "Agent reports current task",
  agent_inference: "Agent inference",
  product_activity: "Product activity",
  company_assertion: "Company assertion",
};

const healthCopy: Record<string, string> = {
  healthy: "Healthy",
  helped: "Helped",
  at_risk: "At risk",
  hindered: "Hindered",
  blocked: "Blocked",
  unknown: "Unknown",
};

export function identityLabel(value: string) {
  return identityCopy[value] ?? titleCase(value);
}

export function provenanceLabel(value: string) {
  return provenanceCopy[value] ?? titleCase(value);
}

export function healthLabel(value: string) {
  return healthCopy[value] ?? titleCase(value);
}

export function consentLabel(value: string) {
  return value === "approved" ? "Allowed" : titleCase(value);
}

export function IdentityBadge({ level }: { level: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        level === "verified" && "border-impact-positive/50 text-impact-positive",
        level === "pseudonymous" && "border-attention/50 text-attention-foreground",
        (level === "ephemeral" || level === "unclassified") && "text-muted-foreground",
      )}
    >
      {identityLabel(level)}
    </Badge>
  );
}

export function ProvenanceBadge({ provenance }: { provenance: string }) {
  return (
    <Badge
      variant={provenance === "agent_inference" ? "outline" : "secondary"}
      title={
        provenance === "agent_inference"
          ? "This is an inference, not a confirmed user fact."
          : undefined
      }
    >
      {provenanceLabel(provenance)}
    </Badge>
  );
}

export function ConsentBadge({ state }: { state: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        state === "approved" && "border-impact-positive/50 text-impact-positive",
        (state === "revoked" || state === "declined" || state === "expired") &&
          "border-impact-negative/40 text-impact-negative",
      )}
    >
      {consentLabel(state)}
    </Badge>
  );
}

export function OutcomeHealth({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-[1px] bg-muted-foreground",
          (value === "healthy" || value === "helped") && "bg-impact-positive",
          value === "at_risk" && "bg-impact-caution",
          value === "hindered" && "bg-impact-warning",
          value === "blocked" && "bg-impact-negative",
        )}
      />
      {healthLabel(value)}
    </span>
  );
}

export function ConfidenceLabel({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">Confidence not supplied</span>;
  return <span>{Math.round(value * 100)}% confidence</span>;
}
