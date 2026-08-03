import type { DashboardData } from "@/lib/api/dashboard";

export const DASHBOARD_NAV_VIEWS = [
  "home",
  "customers",
  "responses",
  "sessions",
  "setup",
  "connectors",
  "policy",
] as const;
export const DASHBOARD_VIEWS = [
  ...DASHBOARD_NAV_VIEWS,
  "features",
  "configuration",
  "feedback",
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
