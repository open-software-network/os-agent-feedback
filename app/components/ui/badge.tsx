import * as React from "react";

import { cn } from "../../lib/utils";

export type BadgeVariant = "default" | "secondary" | "outline";

const badgeBase =
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium transition-colors [&>svg]:size-3 [&>svg]:pointer-events-none";

const badgeVariantClasses: Record<BadgeVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border bg-background text-foreground",
};

export function badgeVariants({
  variant = "default",
  className,
}: { variant?: BadgeVariant; className?: string } = {}) {
  return cn(badgeBase, badgeVariantClasses[variant], className);
}

export interface BadgeProps extends React.ComponentProps<"span"> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={badgeVariants({ variant, className })}
      {...props}
    />
  );
}
