"use client";

import type { ReactNode } from "react";
import type { DashboardView } from "@/components/dashboard/types";
import { Panel } from "@/components/dashboard/view-primitives";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import type { DashboardData } from "@/lib/api/dashboard";
import { titleCase } from "@/lib/dashboard/format";

export type ConfigurationSection = "configuration" | "setup" | "policy" | "connectors" | "team";

const sectionContent: Record<ConfigurationSection, { label: string }> = {
  configuration: { label: "Product" },
  setup: { label: "Setup" },
  policy: { label: "Collection" },
  connectors: { label: "Connectors" },
  team: { label: "Team" },
};

export function ConfigurationView({
  data,
  section,
  onSectionChange,
  children,
}: {
  data: DashboardData;
  section: ConfigurationSection;
  onSectionChange: (section: ConfigurationSection) => void;
  children: ReactNode;
}) {
  const editor = data.currentRole === "owner" || data.currentRole === "admin";
  const sections: ConfigurationSection[] = editor
    ? ["configuration", "setup", "policy", "connectors", "team"]
    : ["configuration", "team"];
  return (
    <div className="flex size-full min-h-0 flex-col bg-canvas">
      <Tabs
        value={section}
        onValueChange={(value) => onSectionChange(value as ConfigurationSection)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="shrink-0 overflow-x-auto border-b bg-background px-4 md:px-6">
          <TabsList variant="line" aria-label="Configuration sections">
            {sections.map((item) => (
              <TabsTab key={item} value={item}>
                {sectionContent[item].label}
              </TabsTab>
            ))}
          </TabsList>
        </div>
        <TabsPanel value={section} className="min-h-0 overflow-auto p-4 md:p-6">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </TabsPanel>
      </Tabs>
    </div>
  );
}

export function ProductConfigurationView({
  data,
  controls,
}: {
  data: DashboardData;
  controls: ReactNode;
}) {
  const product = data.currentProduct;
  const canManageProduct = data.currentRole === "owner" || data.currentRole === "admin";

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Product details">
        <dl className="divide-y text-sm">
          <Property label="Product" value={product?.name ?? "No product selected"} />
          <Property label="Team" value={data.workspace.name} />
          <Property label="Your role" value={titleCase(data.currentRole)} />
        </dl>
      </Panel>
      {canManageProduct ? <Panel title="Product management">{controls}</Panel> : null}
    </div>
  );
}

function Property({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function isConfigurationSection(view: DashboardView): view is ConfigurationSection {
  return view in sectionContent;
}
