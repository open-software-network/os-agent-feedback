"use client";

import { Fragment, type ReactNode } from "react";

import type { DashboardData } from "@/lib/api/dashboard";
import { cn } from "@/lib/utils";

type Insights = DashboardData["insights"];

type ExperienceInsightKey =
  | "lostDemand"
  | "journeyFlow"
  | "handoff"
  | "signalOutcomes"
  | "agentVendors"
  | "rankPositions"
  | "unknownDimensions"
  | "unansweredQuestions";

/**
 * The seven experience insight groups may be absent from older dashboard
 * payloads, so every field is read with a safe fallback.
 */
export type ExperienceInsightsData = Omit<Insights, ExperienceInsightKey> &
  Partial<Pick<Insights, ExperienceInsightKey>>;

const emptyLostDemand: Insights["lostDemand"] = {
  counterfactualChanges: [],
  decisionInteractions: 0,
  expressedDimensions: [],
  medianCounterfactualDelta: null,
  violatedDimensions: [],
  zeroMatchDecisions: 0,
};

const emptyJourneyFlow: Insights["journeyFlow"] = { edges: [], exitOperations: [] };

const emptyHandoff: Insights["handoff"] = {
  handoffClicks: 0,
  handoffRate: 0,
  landingOperations: [],
  sessions: 0,
  sessionsWithHandoff: 0,
};

const agentVendorLabels: Record<string, string> = {
  claude: "Claude",
  cohere: "Cohere",
  copilot: "Copilot",
  gemini: "Gemini",
  openai: "OpenAI",
  other: "Other",
  perplexity: "Perplexity",
};

function agentVendorLabel(vendor: string): string {
  return agentVendorLabels[vendor] ?? vendor;
}

function countNoun(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

export function ExperienceInsights({ insights }: { insights: ExperienceInsightsData }) {
  const lostDemand = insights.lostDemand ?? emptyLostDemand;
  const journeyFlow = insights.journeyFlow ?? emptyJourneyFlow;
  const handoff = insights.handoff ?? emptyHandoff;
  const signalOutcomes = insights.signalOutcomes ?? [];
  const agentVendors = insights.agentVendors ?? [];
  const rankPositions = insights.rankPositions ?? [];
  const unknownDimensions = insights.unknownDimensions ?? [];
  const unansweredQuestions = insights.unansweredQuestions ?? [];

  const zeroMatchShare = lostDemand.decisionInteractions
    ? `${Math.round((lostDemand.zeroMatchDecisions / lostDemand.decisionInteractions) * 100)}%`
    : "—";
  const medianGap =
    lostDemand.medianCounterfactualDelta == null
      ? "—"
      : (Math.round(lostDemand.medianCounterfactualDelta * 100) / 100).toLocaleString();
  const journeyEdges = journeyFlow.edges.map((edge) => ({
    name: `${edge.fromOperation} → ${edge.toOperation}`,
    count: edge.traversals,
  }));
  const rankRows = rankPositions.map((row) => ({
    name: `Position ${row.name}`,
    count: row.count,
  }));

  return (
    <>
      <InsightSection eyebrow="Lost demand" title="What agents asked for and could not get">
        <FunnelSteps
          steps={[
            {
              value: lostDemand.decisionInteractions.toLocaleString(),
              label: "Decisions evaluated",
            },
            {
              value: lostDemand.zeroMatchDecisions.toLocaleString(),
              label: `Zero exact matches (${zeroMatchShare})`,
            },
            { value: medianGap, label: "Median gap to a match" },
          ]}
        />
        <div className="grid gap-4 md:grid-cols-3">
          <BreakdownColumn title="Stated demand">
            <CountList
              mono
              rows={lostDemand.expressedDimensions}
              emptyMessage="No expressed dimensions yet."
            />
          </BreakdownColumn>
          <BreakdownColumn title="Dealbreaker dimensions">
            <CountList
              mono
              rows={lostDemand.violatedDimensions}
              emptyMessage="No hard-constraint violations yet."
            />
          </BreakdownColumn>
          <BreakdownColumn title="Cheapest fixes">
            <CountList
              mono
              rows={lostDemand.counterfactualChanges}
              emptyMessage="No counterfactuals yet. They appear when a search ends with zero exact matches."
            />
          </BreakdownColumn>
        </div>
      </InsightSection>

      <div className="grid gap-5 lg:grid-cols-2">
        <InsightSection eyebrow="Journey flow" title="Where agents go next">
          <CountList
            mono
            rows={journeyEdges}
            emptyMessage="Transitions appear when journeys carry a session reference."
          />
        </InsightSection>
        <InsightSection eyebrow="Drop-off" title="Where journeys end">
          <CountList
            mono
            rows={journeyFlow.exitOperations}
            emptyMessage="No journey exits in the last 30 days."
          />
        </InsightSection>
      </div>

      <InsightSection eyebrow="Handoff" title="From agent journey to human click">
        <FunnelSteps
          steps={[
            { value: handoff.sessions.toLocaleString(), label: "Proven sessions" },
            {
              value: handoff.sessionsWithHandoff.toLocaleString(),
              label: `Sessions with a handoff (${handoff.handoffRate}%)`,
            },
            { value: handoff.handoffClicks.toLocaleString(), label: "Product link clicks" },
          ]}
        />
        {handoff.landingOperations.length ? (
          <BreakdownColumn title="Handoff landing pages">
            <CountList
              mono
              rows={handoff.landingOperations}
              total={handoff.handoffClicks}
              emptyMessage=""
            />
          </BreakdownColumn>
        ) : (
          <p className="text-sm text-muted-foreground">
            Landing pages appear when a proven session records a product link click.
          </p>
        )}
      </InsightSection>

      <div className="grid gap-5 lg:grid-cols-2">
        <InsightSection eyebrow="Context ROI" title="Signals that drive outcomes">
          {signalOutcomes.length ? (
            <ul className="divide-y">
              {signalOutcomes.map((row) => (
                <li key={row.signal} className="py-2 first:pt-0 last:pb-0">
                  <p className="min-w-0 break-words font-mono text-xs font-medium">{row.signal}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {countNoun(row.decisions, "decision")} · {countNoun(row.outcomes, "outcome")} ·{" "}
                    {countNoun(row.conversions, "conversion")}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No personalization decisions cited customer signals yet.
            </p>
          )}
        </InsightSection>
        <InsightSection eyebrow="Agent mix" title="Traffic by assistant runtime">
          {agentVendors.length ? (
            <ul className="divide-y">
              {agentVendors.map((row) => (
                <li
                  key={row.vendor}
                  className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <span className="min-w-0 break-words text-sm font-medium">
                    {agentVendorLabel(row.vendor)}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {countNoun(row.interactions, "interaction")} ·{" "}
                    {countNoun(row.sessions, "session")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Runtime evidence has not named an assistant yet.
            </p>
          )}
          <p className="text-[11px] leading-4 text-muted-foreground">
            <span className="font-medium text-foreground">Unverified evidence.</span> Runtime hints
            and user-agent values are unverified observations, never identity.
          </p>
        </InsightSection>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <InsightSection eyebrow="Rank positions" title="Result position views">
          <CountList rows={rankRows} emptyMessage="No search-attributed item views yet." />
        </InsightSection>
        <InsightSection
          eyebrow="Unknowns"
          title="What agents could not learn"
          className="lg:col-span-2"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <BreakdownColumn title="Unknown dimensions">
              <CountList
                mono
                rows={unknownDimensions}
                emptyMessage="Agents answered every dimension they were asked."
              />
            </BreakdownColumn>
            <BreakdownColumn title="Unanswered questions">
              <CountList
                mono
                rows={unansweredQuestions}
                emptyMessage="No declined or unanswerable context questions."
              />
            </BreakdownColumn>
          </div>
        </InsightSection>
      </div>
    </>
  );
}

function InsightSection({
  eyebrow,
  title,
  className,
  children,
}: {
  eyebrow: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("border bg-background p-5", className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
      <h3 className="mt-1 text-base font-medium">{title}</h3>
      <div className="mt-4 grid gap-4">{children}</div>
    </section>
  );
}

function FunnelSteps({ steps }: { steps: { value: ReactNode; label: string }[] }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
      {steps.map((step, index) => (
        <Fragment key={step.label}>
          {index > 0 ? (
            <span aria-hidden="true" className="hidden self-center text-muted-foreground sm:block">
              →
            </span>
          ) : null}
          <div className="flex-1 border bg-muted/20 p-3">
            <p className="text-xl font-medium">{step.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{step.label}</p>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function BreakdownColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="text-xs font-medium">{title}</h4>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function CountList({
  rows,
  total,
  emptyMessage,
  mono = false,
}: {
  rows: { name: string; count: number }[];
  total?: number;
  emptyMessage: string;
  mono?: boolean;
}) {
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }
  const denominator = total ?? rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <li
          key={row.name}
          className="flex items-baseline justify-between gap-3 py-1.5 first:pt-0 last:pb-0"
        >
          <span className={cn("min-w-0 break-words text-sm", mono && "font-mono text-xs")}>
            {row.name}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {row.count.toLocaleString()} ·{" "}
            {denominator ? Math.round((row.count / denominator) * 100) : 0}%
          </span>
        </li>
      ))}
    </ul>
  );
}
