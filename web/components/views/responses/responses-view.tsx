"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";

import { MetricStrip } from "@/components/dashboard/metric-strip";
import { EmptyState, ErrorState, NativeSelect } from "@/components/dashboard/view-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  type DashboardData,
  type DashboardResponseSummary,
  fetchDashboardResponsesPage,
} from "@/lib/api/dashboard";
import { relativeDate, titleCase } from "@/lib/dashboard/format";

type ResponseStatus = "all" | DashboardResponseSummary["status"];

const statusLabels: Record<ResponseStatus, string> = {
  all: "All responses",
  answered: "Answered",
  awaiting_answer: "Awaiting answer",
  declined: "Declined",
  no_relevant_context: "No answer available",
};

function readLocation() {
  if (typeof window === "undefined") return { query: "", status: "all" as ResponseStatus };
  const params = new URL(window.location.href).searchParams;
  const status = params.get("responseStatus");
  return {
    query: params.get("responseQ") ?? "",
    status:
      status && status in statusLabels ? (status as ResponseStatus) : ("all" as ResponseStatus),
  };
}

function writeLocation(query: string, status: ResponseStatus) {
  const url = new URL(window.location.href);
  if (query.trim()) url.searchParams.set("responseQ", query.trim());
  else url.searchParams.delete("responseQ");
  if (status === "all") url.searchParams.delete("responseStatus");
  else url.searchParams.set("responseStatus", status);
  window.history.replaceState(window.history.state, "", url);
}

export function ResponsesView({
  data,
  openCustomer,
  openSession,
}: {
  data: DashboardData;
  openCustomer: (customerId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  const initialLocation = useMemo(readLocation, []);
  const [query, setQuery] = useState(initialLocation.query);
  const [status, setStatus] = useState<ResponseStatus>(initialLocation.status);
  const debouncedQuery = useDebouncedValue(query, 250);
  const productId = data.currentProduct?.id;
  const searchSettling = query.trim() !== debouncedQuery.trim();
  const pages = useInfiniteQuery({
    queryKey: ["responses", data.workspace.id, productId, debouncedQuery, status],
    queryFn: ({ pageParam }) =>
      fetchDashboardResponsesPage(data.workspace.id, {
        productId: productId ?? "",
        q: debouncedQuery.trim() || undefined,
        status: status === "all" ? undefined : [status],
        limit: 50,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(productId),
  });
  const responses = searchSettling
    ? []
    : (pages.data?.pages.flatMap((page) => page.responses) ?? []);
  const rollup = pages.data?.pages[0]?.rollup ?? {
    questions: 0,
    answered: 0,
    awaitingAnswer: 0,
    declined: 0,
  };

  useEffect(() => writeLocation(query, status), [query, status]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <MetricStrip
        items={[
          { label: "Questions asked", value: rollup.questions.toLocaleString(), accent: true },
          { label: "Answered", value: rollup.answered.toLocaleString() },
          { label: "Awaiting answer", value: rollup.awaitingAnswer.toLocaleString() },
          { label: "Declined", value: rollup.declined.toLocaleString() },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <InputGroup className="min-w-64 flex-1 sm:max-w-md">
          <InputGroupAddon>
            <IconMagnifyingGlass />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search responses"
            placeholder="Search questions or answers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <NativeSelect
          aria-label="Response status"
          value={status}
          onChange={(event) => setStatus(event.target.value as ResponseStatus)}
        >
          {Object.entries(statusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {pages.isError ? (
          <div className="p-4">
            <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
          </div>
        ) : pages.isPending || searchSettling ? (
          <p className="p-6 text-sm text-muted-foreground">Loading responses…</p>
        ) : responses.length ? (
          <>
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[34%] pl-4">Question</TableHead>
                  <TableHead className="w-[34%]">Answer</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Session</TableHead>
                  <TableHead className="pr-4 text-right">Asked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {responses.map((response) => (
                  <ResponseRow
                    key={response.id}
                    response={response}
                    openCustomer={openCustomer}
                    openSession={openSession}
                  />
                ))}
              </TableBody>
            </Table>
            {pages.hasNextPage ? (
              <div className="flex justify-center border-t p-4">
                <Button
                  variant="outline"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => void pages.fetchNextPage()}
                >
                  {pages.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="p-4">
            <EmptyState
              title={query || status !== "all" ? "No matching responses" : "No responses yet"}
              description={
                query || status !== "all"
                  ? "Try a different search or status."
                  : "Questions and answers will appear here after Epode asks a customer agent."
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ResponseRow({
  response,
  openCustomer,
  openSession,
}: {
  response: DashboardResponseSummary;
  openCustomer: (customerId: string) => void;
  openSession: (sessionId: string) => void;
}) {
  return (
    <TableRow>
      <TableCell className="whitespace-normal py-4 pl-4 align-top">
        <p className="font-medium leading-5">{response.question}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ResponseStatusBadge status={response.status} />
          <span className="text-xs text-muted-foreground">{titleCase(response.purpose)}</span>
        </div>
      </TableCell>
      <TableCell className="whitespace-normal py-4 align-top">
        {response.answers.length ? (
          <dl className="grid gap-2">
            {response.answers.map((answer) => (
              <div key={`${answer.key}-${answer.value}`}>
                <dt className="text-xs text-muted-foreground">{titleCase(answer.key)}</dt>
                <dd className="text-sm leading-5">{answer.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{statusLabels[response.status]}</p>
        )}
      </TableCell>
      <TableCell className="align-top">
        {response.customerId ? (
          <Button
            variant="link"
            className="h-auto justify-start p-0 text-left"
            onClick={() => openCustomer(response.customerId as string)}
          >
            {response.customerName ?? "Customer"}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">
            {response.customerName ?? "Anonymous"}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top">
        {response.sessionId ? (
          <Button
            variant="link"
            className="h-auto justify-start p-0 text-left"
            onClick={() => openSession(response.sessionId as string)}
          >
            {response.sessionRef ?? "Open session"}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="pr-4 text-right align-top text-xs text-muted-foreground">
        {relativeDate(response.askedAt)}
      </TableCell>
    </TableRow>
  );
}

function ResponseStatusBadge({ status }: { status: DashboardResponseSummary["status"] }) {
  return (
    <Badge variant={status === "answered" ? "default" : "secondary"}>{statusLabels[status]}</Badge>
  );
}
