"use client";

import { IconSidebarHiddenLeftWide } from "central-icons/IconSidebarHiddenLeftWide";
import { IconSidebarSimpleLeftWide } from "central-icons/IconSidebarSimpleLeftWide";

import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";

export function SidebarCollapseTrigger() {
  const { isMobile, state, toggleSidebar } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={toggleSidebar}
      aria-label={isMobile ? "Close sidebar" : isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="absolute top-1/2 right-3 shrink-0 -translate-y-1/2"
    >
      {isCollapsed ? (
        <IconSidebarHiddenLeftWide size={18} aria-hidden="true" />
      ) : (
        <IconSidebarSimpleLeftWide size={18} aria-hidden="true" />
      )}
    </Button>
  );
}
