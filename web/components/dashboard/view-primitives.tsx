import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase">{eyebrow}</p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3 rounded-xl border bg-card p-4", className)}>
      {title ? <h2 className="text-base font-medium">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Metrics({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <div className="rounded-xl border bg-card p-4" key={item.label}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 text-xl font-semibold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Panel>
      <h2 className="font-medium">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
      {action}
    </Panel>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <Panel>
      <h2 className="font-medium">Could not load this view</h2>
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
      {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
    </Panel>
  );
}

export function StatusMessage({
  children,
  tone = "status",
}: {
  children: ReactNode;
  tone?: "status" | "error";
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/40 text-destructive",
      )}
    >
      {children}
    </p>
  );
}

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
