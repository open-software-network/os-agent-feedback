import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { NativeSelect as ShadcnNativeSelect } from "@/components/ui/native-select";
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
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{eyebrow}</p>
        <h1 className="text-2xl font-medium">{title}</h1>
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
    <section className={cn("flex flex-col gap-3 border bg-background p-4", className)}>
      {title ? <h2 className="text-base font-medium">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Metrics({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  const columnCount = Math.min(items.length, 4);

  return (
    <dl
      className={cn(
        "grid gap-px border bg-border",
        columnCount === 1 && "sm:grid-cols-1 lg:grid-cols-1",
        columnCount === 2 && "sm:grid-cols-2 lg:grid-cols-2",
        columnCount === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        columnCount === 4 && "sm:grid-cols-2 lg:grid-cols-4",
      )}
    >
      {items.map((item) => (
        <div className="min-w-0 bg-background p-4" key={item.label}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 text-xl font-medium">{item.value}</dd>
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
    <Empty className="min-h-64 border bg-background">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
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

export function NativeSelect({ className, ...props }: ComponentProps<typeof ShadcnNativeSelect>) {
  return <ShadcnNativeSelect className={cn("w-full", className)} {...props} />;
}
