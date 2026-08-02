import type { DashboardData } from "@/lib/api/dashboard";

export const DASHBOARD_NAV_VIEWS = ["customers", "insights", "setup", "policy"] as const;
export const DASHBOARD_VIEWS = [
  ...DASHBOARD_NAV_VIEWS,
  "home",
  "features",
  "sessions",
  "configuration",
  "feedback",
  "connectors",
  "team",
  "interactions",
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export type ShownSecrets = {
  environmentId: string;
  write?: string;
  read?: string;
};

export type ViewBaseProps = {
  data: DashboardData;
  refresh: () => Promise<unknown>;
  setNotice: (message: string) => void;
};
