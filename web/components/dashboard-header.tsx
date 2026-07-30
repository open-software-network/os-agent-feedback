"use client";

import type * as React from "react";

export function DashboardHeader({ breadcrumb }: { breadcrumb?: React.ReactNode }) {
  if (!breadcrumb) return null;
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-background px-4 py-2">
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        {breadcrumb}
      </nav>
    </header>
  );
}
