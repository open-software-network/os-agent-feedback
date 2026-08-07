import {
  ExperienceInsights,
  type ExperienceInsightsData,
} from "@/components/views/home/experience-insights";

export function InsightsView({ insights }: { insights: ExperienceInsightsData }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <ExperienceInsights insights={insights} />
    </div>
  );
}
