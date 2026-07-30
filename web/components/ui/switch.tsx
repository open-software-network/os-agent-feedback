"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input/80 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3 translate-x-0.5 rounded-full bg-background shadow-sm ring-0 transition-transform data-[checked]:translate-x-[14px]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
