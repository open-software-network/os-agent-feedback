import * as React from "react";

import { cn } from "../../lib/utils";

export type ButtonVariant =
  | "default"
  | "outline"
  | "ghost"
  | "secondary"
  | "link";

export type ButtonSize = "default" | "sm" | "lg";

const buttonBase =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-[color,background-color,border-color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const buttonVariantClasses: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  outline:
    "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  secondary:
    "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
  link: "text-foreground underline-offset-4 hover:underline",
};

const buttonSizeClasses: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2 has-[>svg]:px-3.5",
  sm: "h-8 gap-1.5 rounded-md px-3 text-[13px] has-[>svg]:px-2.5",
  lg: "h-11 rounded-md px-6 has-[>svg]:px-5",
};

export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return cn(
    buttonBase,
    buttonVariantClasses[variant],
    buttonSizeClasses[size],
    variant === "link" && "h-auto px-0",
    className,
  );
}

export interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
}

export interface ButtonLinkProps extends React.ComponentProps<"a"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * Anchor styled with the button recipe. Used instead of Radix `asChild`,
 * which is unavailable here (no @radix-ui/react-slot dependency).
 */
export function ButtonLink({
  className,
  variant,
  size,
  ...props
}: ButtonLinkProps) {
  return (
    <a
      data-slot="button"
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  );
}
