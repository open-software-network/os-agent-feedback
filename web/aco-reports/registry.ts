import type { ComponentType } from "react";

/**
 * Registry of available ACO (AI Commerce Optimization) reports. Report
 * content is a React component compiled into the app, so a slug that is not
 * registered here does not exist as far as the route is concerned — the
 * registry is what makes a report renderable, and the password
 * (ACO_REPORT_PASSWORDS) is what publishes it.
 */
export const acoReportLoaders: Record<string, () => Promise<{ default: ComponentType }>> = {
  petsmart: () => import("./petsmart/report"),
};
