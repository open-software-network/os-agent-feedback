"use client";

import { useQuery } from "@tanstack/react-query";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchCustomersPage } from "@/lib/api/customer-intelligence";
import {
  type DashboardData,
  type DashboardResponseSummary,
  fetchDashboardResponsesPage,
} from "@/lib/api/dashboard";
import { isEditor, relativeDate } from "@/lib/dashboard/format";

export function HomeView({
  data,
  openCustomer = () => undefined,
  openSession = () => undefined,
  refresh,
}: {
  data: DashboardData;
  openCustomer?: (customerId: string) => void;
  openSession?: (sessionId: string) => void;
  openFeature?: (featureKey: string) => void;
  openFeedback: (reportId: string) => void;
  refresh: () => Promise<unknown>;
}) {
  const productId = data.currentProduct?.id;
  const customers = useQuery({
    queryKey: ["home-customers", data.workspace.id, productId],
    queryFn: () => fetchCustomersPage(data.workspace.id, { productId: productId ?? "", limit: 6 }),
    enabled: Boolean(productId),
  });
  const responses = useQuery({
    queryKey: ["home-responses", data.workspace.id, productId],
    queryFn: () =>
      fetchDashboardResponsesPage(data.workspace.id, { productId: productId ?? "", limit: 6 }),
    enabled: Boolean(productId),
  });
  const customerRows = customers.data?.customers ?? [];
  const responseRows = responses.data?.responses ?? [];
  const responseRollup = responses.data?.rollup ?? {
    questions: 0,
    answered: 0,
    awaitingAnswer: 0,
    declined: 0,
  };
  const needsSetup = data.insights.opportunities === 0 && isEditor(data.currentRole);

  async function refreshHome() {
    await Promise.all([refresh(), customers.refetch(), responses.refetch()]);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <section aria-labelledby="home-title" className="border bg-background">
        <div className="p-5 md:p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span aria-hidden="true" className="size-1.5 bg-attention" />
              Question and answer
            </div>
            <Button variant="ghost" size="sm" onClick={() => void refreshHome()}>
              Refresh
            </Button>
          </div>
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

      <section aria-labelledby="core-objects-title" className="border bg-background">
        <SectionHeader id="core-objects-title" title="At a glance" />
        <dl className="grid sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Customers" value={customers.data?.rollup?.customers ?? 0} />
          <Metric label="Questions asked" value={responseRollup.questions} />
          <Metric label="Answers received" value={responseRollup.answered} />
          <Metric label="Sessions" value={data.listState.sessionsTotal} />
        </dl>
      </section>

      <section aria-labelledby="recent-responses-title" className="border bg-background">
        <SectionHeader
          id="recent-responses-title"
          title="Recent responses"
          description="The latest questions Epode asked and answers customer agents returned"
          action={
            <Button variant="ghost" size="sm" onClick={() => navigateToDashboardView("responses")}>
              View all responses
              <IconArrowUpRight data-icon="inline-end" />
            </Button>
          }
        />
        {responses.isError ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            Responses could not be loaded.
          </p>
        ) : responses.isPending ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading responses…</p>
        ) : responseRows.length ? (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[42%] pl-4">Question</TableHead>
                <TableHead className="w-[36%]">Answer</TableHead>
                <TableHead className="pr-4 text-right">Asked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {responseRows.map((response) => (
                <TableRow key={response.id}>
                  <TableCell className="whitespace-normal pl-4 font-medium">
                    <p>{response.question}</p>
                    {response.sessionId ? (
                      <Button
                        variant="link"
                        className="mt-1 h-auto p-0 text-xs font-normal"
                        onClick={() => openSession(response.sessionId as string)}
                      >
                        {response.sessionRef ?? "Open session"}
                      </Button>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <ResponseAnswer response={response} />
                  </TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    {relativeDate(response.askedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            No questions have been asked yet.
          </p>
        )}
      </section>

      <section aria-labelledby="recent-customers-title" className="border bg-background">
        <SectionHeader
          id="recent-customers-title"
          title="Recent customers"
          description="Customers linked to product sessions and responses"
          action={
            <Button variant="ghost" size="sm" onClick={() => navigateToDashboardView("customers")}>
              View all customers
              <IconArrowUpRight data-icon="inline-end" />
            </Button>
          }
        />
        {customers.isError ? (
          <p className="px-4 py-6 text-sm text-destructive" role="alert">
            Customers could not be loaded.
          </p>
        ) : customers.isPending ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading customers…</p>
        ) : customerRows.length ? (
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Customer</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customerRows.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell className="pl-4">
                    <Button
                      variant="link"
                      className="h-auto justify-start p-0 text-left"
                      onClick={() => openCustomer(customer.id)}
                    >
                      {customer.displayName}
                    </Button>
                  </TableCell>
                  <TableCell>{customer.sessionCount}</TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {relativeDate(customer.lastActivityAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="px-4 py-8 text-sm text-muted-foreground">No customers yet.</p>
        )}
      </section>
    </div>
  );
}

function ResponseAnswer({ response }: { response: DashboardResponseSummary }) {
  if (response.answers.length) {
    return <>{response.answers.map((answer) => answer.value).join(" · ")}</>;
  }
  const labels: Record<DashboardResponseSummary["status"], string> = {
    answered: "Answered",
    awaiting_answer: "Awaiting answer",
    declined: "Declined",
    no_relevant_context: "No answer available",
  };
  return <span className="text-muted-foreground">{labels[response.status]}</span>;
}

function SectionHeader({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
      <div>
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 border-b p-4 last:border-b-0 lg:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-2xl font-medium">{value}</dd>
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
