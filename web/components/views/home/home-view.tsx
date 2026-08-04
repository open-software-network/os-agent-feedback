"use client";

import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import Image from "next/image";

import { Button } from "@/components/ui/button";
import type { DashboardData } from "@/lib/api/dashboard";
import { isEditor } from "@/lib/dashboard/format";

export function HomeView({
  data,
}: {
  data: DashboardData;
  openCustomer?: (customerId: string) => void;
  openSession?: (sessionId: string) => void;
  openFeedback: (reportId: string) => void;
  refresh: () => Promise<unknown>;
}) {
  const needsSetup = data.insights.opportunities === 0 && isEditor(data.currentRole);

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <section aria-labelledby="home-title" className="border bg-background">
        <div className="p-5 md:p-6">
          <Image src="/epode-logo.svg" alt="EPODE" width={56} height={13} className="dark:invert" />
          <h2 id="home-title" className="mt-4 max-w-2xl text-2xl font-medium">
            Epode asks customer agents questions and records their answers.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Every response stays connected to the customer and session where the question was asked,
            so your team can understand who answered, what they said, and when.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {needsSetup ? (
              <Button onClick={() => navigateToDashboardView("setup")}>Finish setup</Button>
            ) : (
              <Button onClick={() => navigateToDashboardView("responses")}>
                View responses
                <IconArrowUpRight data-icon="inline-end" />
              </Button>
            )}
            <Button variant="outline" onClick={() => navigateToDashboardView("customers")}>
              View customers
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

type VisibleDashboardView = "customers" | "responses" | "sessions" | "setup";

function navigateToDashboardView(view: VisibleDashboardView) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  for (const parameter of ["customer", "feature", "report", "session", "interaction"]) {
    url.searchParams.delete(parameter);
  }
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
