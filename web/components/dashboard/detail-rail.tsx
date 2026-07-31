"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const wideInspectorQuery = "(min-width: 72rem)";

function useWideInspector() {
  const [isWide, setIsWide] = useState(false);

  useLayoutEffect(() => {
    const media = window.matchMedia(wideInspectorQuery);
    const update = () => setIsWide(media.matches);

    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isWide;
}

export function DetailWorkspace({
  open,
  children,
  inspector,
  className,
}: {
  open: boolean;
  children: ReactNode;
  inspector: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col transition-[padding-right] duration-200 ease-out motion-reduce:transition-none",
        open && "min-[72rem]:pr-96 min-[90rem]:pr-[26rem]",
        className,
      )}
    >
      {children}
      {inspector}
    </div>
  );
}

export function DetailRail({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const isWide = useWideInspector();
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !isWide) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isWide, open]);

  if (!open) return null;

  if (isWide) {
    return (
      <aside
        className="fixed inset-y-0 right-0 z-30 flex w-96 min-h-0 flex-col border-l bg-background outline-none motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:duration-200 motion-safe:ease-out min-[90rem]:w-[26rem]"
        aria-label={label}
      >
        {children}
      </aside>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full max-w-none gap-0 p-0 sm:max-w-[26rem]"
      >
        <SheetTitle className="sr-only">{label}</SheetTitle>
        <SheetDescription className="sr-only">
          Inspect the selected record without leaving the current list.
        </SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}
