import type { ReactNode } from "react";

export function MetricStrip({
  items,
}: {
  items: { label: string; value: ReactNode; detail?: ReactNode; accent?: boolean }[];
}) {
  return (
    <dl className="grid border-b bg-background sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="min-w-0 border-b px-4 py-3 last:border-b-0 sm:odd:border-r sm:[&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0"
        >
          <dt className="flex items-center gap-2 text-xs text-muted-foreground">
            {item.accent ? (
              <span className="size-1.5 shrink-0 bg-attention" aria-hidden="true" />
            ) : null}
            {item.label}
          </dt>
          <dd className="mt-1 flex items-baseline gap-2">
            <span className="text-lg font-medium">{item.value}</span>
            {item.detail ? (
              <span className="text-xs text-muted-foreground">{item.detail}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
