import type { ReactNode } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";

export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3 md:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="md:hidden" />
        <h1 className="truncate text-sm font-medium">{title}</h1>
        {meta ? (
          <span className="truncate text-xs text-muted-foreground md:hidden">{meta}</span>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
