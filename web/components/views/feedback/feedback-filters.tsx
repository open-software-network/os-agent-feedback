"use client";

import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconFilterTimeline } from "central-icons/IconFilterTimeline";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const workflowStatuses = [
  "new",
  "investigating",
  "planned",
  "resolved",
  "wont_act",
] as const;

export type WorkflowStatus = (typeof workflowStatuses)[number];

export const workflowLabels: Record<WorkflowStatus, string> = {
  new: "New",
  investigating: "Investigating",
  planned: "Planned",
  resolved: "Resolved",
  wont_act: "Won't act",
};

export const impactValues = [
  "blocked",
  "hindered",
  "helped_with_friction",
  "helped",
  "neutral",
  "unknown",
] as const;

export const impactLabels: Record<string, string> = {
  blocked: "Blocked",
  hindered: "Hindered",
  helped_with_friction: "Helped with friction",
  helped: "Helped",
  neutral: "Neutral",
  unknown: "Unknown",
};

export type FeedbackFacet =
  | "status"
  | "impact"
  | "surface"
  | "topic"
  | "kind"
  | "severity"
  | "tag"
  | "assignee"
  | "workaround";

export type FilterOption = {
  value: string;
  label: string;
};

export type FeedbackFiltersState = Record<FeedbackFacet, string[]>;

export const facetOrder: FeedbackFacet[] = [
  "status",
  "impact",
  "surface",
  "topic",
  "kind",
  "severity",
  "tag",
  "assignee",
  "workaround",
];

export const facetLabels: Record<FeedbackFacet, string> = {
  status: "Workflow",
  impact: "Impact",
  surface: "Interface",
  topic: "Topic",
  kind: "Finding type",
  severity: "Severity",
  tag: "Tag",
  assignee: "Assignee",
  workaround: "Workaround",
};

type FilterCategory = FeedbackFacet | "range";

const categories: FilterCategory[] = [...facetOrder, "range"];
const categoryLabels: Record<FilterCategory, string> = {
  ...facetLabels,
  range: "Received",
};
const rangeOptions = [
  { label: "All time", value: "all" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
];

export function createEmptyFilters(): FeedbackFiltersState {
  return facetOrder.reduce((filters, facet) => {
    filters[facet] = [];
    return filters;
  }, {} as FeedbackFiltersState);
}

export function FeedbackFilters({
  query,
  onQueryChange,
  filters,
  options,
  range,
  onRangeChange,
  onToggle,
  onClearFacet,
  onClearAll,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  filters: FeedbackFiltersState;
  options: Record<FeedbackFacet, FilterOption[]>;
  range: string;
  onRangeChange: (value: string) => void;
  onToggle: (facet: FeedbackFacet, value: string) => void;
  onClearFacet: (facet: FeedbackFacet) => void;
  onClearAll: () => void;
}) {
  const [activeCategory, setActiveCategory] = useState<FilterCategory>("status");
  const activeFacets = facetOrder.filter((facet) => filters[facet].length > 0);
  const activeCount = activeFacets.length + (range === "30d" ? 0 : 1);

  function selectedLabel(facet: FeedbackFacet) {
    const selected = filters[facet];
    const first = options[facet].find((option) => option.value === selected[0]);
    if (!first) return `${selected.length} selected`;
    return selected.length > 1 ? `${first.label} +${selected.length - 1}` : first.label;
  }

  function categoryCount(category: FilterCategory) {
    return category === "range" ? (range === "30d" ? 0 : 1) : filters[category].length;
  }

  return (
    <div className="border-b bg-background">
      <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <InputGroup className="min-w-0 flex-1 bg-background sm:max-w-xl">
          <InputGroupAddon>
            <IconMagnifyingGlass />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search feedback"
            placeholder="Search feedback, evidence, operation, or customer"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear feedback search"
                onClick={() => onQueryChange("")}
              >
                <IconCrossSmall />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>
            <IconFilterTimeline data-icon="inline-start" />
            Filters
            {activeCount > 0 ? <Badge variant="secondary">{activeCount}</Badge> : null}
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-[min(28rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0"
          >
            <PopoverHeader className="border-b px-3 py-2.5">
              <PopoverTitle>Filter feedback</PopoverTitle>
            </PopoverHeader>
            <Tabs
              orientation="vertical"
              value={activeCategory}
              onValueChange={(value) => setActiveCategory(value as FilterCategory)}
              className="grid min-h-64 grid-cols-[9rem_minmax(0,1fr)] gap-0"
            >
              <TabsList
                variant="line"
                aria-label="Feedback filter categories"
                className="h-full w-full items-stretch justify-start gap-0 border-r bg-muted/25 p-1.5"
              >
                {categories.map((category) => {
                  const count = categoryCount(category);
                  return (
                    <TabsTab
                      key={category}
                      value={category}
                      className="h-8 w-full justify-between rounded-none px-2 text-xs"
                    >
                      {categoryLabels[category]}
                      {count > 0 ? (
                        <span className="text-[10px] text-muted-foreground">{count}</span>
                      ) : null}
                    </TabsTab>
                  );
                })}
              </TabsList>

              {facetOrder.map((facet) => (
                <TabsPanel key={facet} value={facet} className="max-h-72 overflow-y-auto p-2">
                  {options[facet].length ? (
                    <fieldset className="flex flex-col gap-1">
                      <legend className="sr-only">{facetLabels[facet]}</legend>
                      {options[facet].map((option, index) => {
                        const id = `feedback-filter-${facet}-${index}`;
                        return (
                          <div
                            key={option.value}
                            className="flex min-h-8 items-center gap-2 px-2 text-xs hover:bg-muted"
                          >
                            <Checkbox
                              id={id}
                              checked={filters[facet].includes(option.value)}
                              onCheckedChange={() => onToggle(facet, option.value)}
                            />
                            <Label
                              htmlFor={id}
                              className="min-w-0 flex-1 cursor-pointer font-normal"
                            >
                              <span className="truncate">{option.label}</span>
                            </Label>
                          </div>
                        );
                      })}
                    </fieldset>
                  ) : (
                    <p className="px-2 py-3 text-xs text-muted-foreground">No values available.</p>
                  )}
                </TabsPanel>
              ))}

              <TabsPanel value="range" className="p-2">
                <ToggleGroup
                  orientation="vertical"
                  value={[range]}
                  onValueChange={(value) => {
                    const nextRange = value[0];
                    if (nextRange) onRangeChange(nextRange);
                  }}
                  className="w-full items-stretch gap-1"
                >
                  {rangeOptions.map((option) => (
                    <ToggleGroupItem
                      key={option.value}
                      value={option.value}
                      className="w-full justify-start"
                    >
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </TabsPanel>
            </Tabs>
          </PopoverContent>
        </Popover>
      </div>

      {activeCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2">
          {activeFacets.map((facet) => (
            <Button
              key={facet}
              variant="outline"
              size="xs"
              onClick={() => onClearFacet(facet)}
              aria-label={`Clear ${facetLabels[facet]} filter`}
            >
              <span className="text-muted-foreground">{facetLabels[facet]}:</span>
              {selectedLabel(facet)}
              <IconCrossSmall data-icon="inline-end" />
            </Button>
          ))}
          {range !== "30d" ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onRangeChange("30d")}
              aria-label="Clear Received filter"
            >
              <span className="text-muted-foreground">Received:</span>
              {range === "7d" ? "Last 7 days" : "All time"}
              <IconCrossSmall data-icon="inline-end" />
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={onClearAll}>
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
