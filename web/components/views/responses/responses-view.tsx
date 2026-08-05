"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, ErrorState } from "@/components/dashboard/view-primitives";
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

function readLocation() {
  if (typeof window === "undefined") return { query: "" };
  const params = new URL(window.location.href).searchParams;
  return { query: params.get("responseQ") ?? "" };
}

function writeLocation(query: string) {
  const url = new URL(window.location.href);
  if (query.trim()) url.searchParams.set("responseQ", query.trim());
  else url.searchParams.delete("responseQ");
  url.searchParams.delete("responseStatus");
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
  const debouncedQuery = useDebouncedValue(query, 250);
  const productId = data.currentProduct?.id;
  const searchSettling = query.trim() !== debouncedQuery.trim();
  const pages = useInfiniteQuery({
    queryKey: ["responses", data.workspace.id, productId, debouncedQuery],
    queryFn: ({ pageParam }) =>
      fetchDashboardResponsesPage(data.workspace.id, {
        productId: productId ?? "",
        q: debouncedQuery.trim() || undefined,
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

  useEffect(() => writeLocation(query), [query]);

  useEffect(() => {
    const restoreSearch = () => setQuery(readLocation().query);
    window.addEventListener("popstate", restoreSearch);
    return () => window.removeEventListener("popstate", restoreSearch);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <InputGroup className="min-w-64 flex-1 sm:max-w-md">
          <InputGroupAddon>
            <IconMagnifyingGlass />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search responses"
            placeholder="Search answers or tools"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      </div>
      <p className="border-b bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
        The audit log of context shared by customer agents, linked to the journey that used it.
      </p>

      <div className="min-h-0 flex-1 overflow-auto">
        {pages.isError ? (
          <div className="p-4">
            <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
          </div>
        ) : pages.isPending || searchSettling ? (
          <p className="p-6 text-sm text-muted-foreground">Loading responses…</p>
        ) : responses.length ? (
          <>
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[42%] pl-4">Answer</TableHead>
                  <TableHead className="w-[18%]">Tool called</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Journey</TableHead>
                  <TableHead className="pr-4 text-right">Recorded</TableHead>
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
              title={query ? "No matching responses" : "No responses yet"}
              description={
                query
                  ? "Try a different search."
                  : "Answers appear here when a customer agent shares context during a journey."
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
          <p className="text-sm text-muted-foreground">{responseEmptyCopy(response.status)}</p>
        )}
      </TableCell>
      <TableCell className="whitespace-normal py-4 align-top">
        <code className="break-all text-xs">{response.operation}</code>
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
            {response.sessionRef ?? "Open journey"}
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

function responseEmptyCopy(status: DashboardResponseSummary["status"]): string {
  const copy: Record<DashboardResponseSummary["status"], string> = {
    answered: "No answer content was recorded.",
    awaiting_answer: "Waiting for shared context.",
    declined: "The customer agent declined to share context.",
    no_relevant_context: "No relevant context was shared.",
  };
  return copy[status];
}
