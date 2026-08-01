"use client";

import { IconBubbleText } from "central-icons/IconBubbleText";
import { IconChevronGrabberVertical } from "central-icons/IconChevronGrabberVertical";
import { IconListBulletsSquare } from "central-icons/IconListBulletsSquare";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconSparkle } from "central-icons/IconSparkle";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { PageHeader } from "@/components/dashboard/page-header";
import { EpodeMark } from "@/components/epode-mark";
import { SidebarCollapseTrigger } from "@/components/sidebar-collapse-trigger";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import type { DashboardData } from "@/lib/api/dashboard";
import { cn } from "@/lib/utils";

import type { DashboardView } from "./types";

type NavigationIcon = ComponentType<{
  className?: string;
  size?: number;
  "aria-hidden"?: boolean;
  "data-icon"?: string;
}>;

const configurationViews = new Set<DashboardView>([
  "configuration",
  "setup",
  "policy",
  "connectors",
  "team",
]);

const navigation: Array<{
  view: DashboardView;
  label: string;
  icon: NavigationIcon;
  count?: (data: DashboardData) => number;
}> = [
  { view: "home", label: "Home", icon: IconSparkle },
  {
    view: "feedback",
    label: "Feedback",
    icon: IconBubbleText,
    count: (data) => data.listState.reportsTotal,
  },
  {
    view: "sessions",
    label: "Sessions",
    icon: IconListBulletsSquare,
    count: (data) => data.listState.sessionsTotal,
  },
  { view: "configuration", label: "Configuration", icon: IconSettingsGear4 },
];

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function AppSidebar({
  data,
  view,
  onNavigate,
  onWorkspaceChange,
  onProductChange,
  onLogout,
}: {
  data: DashboardData;
  view: DashboardView;
  onNavigate: (view: DashboardView) => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onProductChange: (productId: string) => void;
  onLogout: () => void;
}) {
  const { isMobile, setOpenMobile, state } = useSidebar();
  const isCollapsed = !isMobile && state === "collapsed";
  const productName = data.currentProduct?.name ?? "No product selected";
  const userInitials = initials(data.user.displayName) || "OS";
  const canCreateProduct = data.currentRole === "owner" || data.currentRole === "admin";
  const canOpenContext =
    canCreateProduct || data.workspaceMemberships.length > 1 || data.products.length > 1;

  function contextChanged(change: () => void) {
    change();
    if (isMobile) setOpenMobile(false);
  }

  const contextIdentity = (
    <>
      <EpodeMark />
      <div className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-medium">{productName}</span>
        <span className="truncate text-xs text-muted-foreground">{data.workspace.name}</span>
      </div>
      {canOpenContext ? (
        <IconChevronGrabberVertical className="shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="h-12 shrink-0 justify-center border-b px-2 py-0">
        <div className="relative flex h-7 items-center">
          {canOpenContext ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${productName}, ${data.workspace.name} - open context menu`}
                    className={cn(
                      "group/context mr-10 flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-1 py-1 text-left transition-[opacity,transform,background-color] duration-150 ease-out hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent motion-reduce:transition-none",
                      isCollapsed
                        ? "pointer-events-none -translate-x-1 opacity-0"
                        : "translate-x-0 opacity-100",
                    )}
                  />
                }
              >
                {contextIdentity}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={6} className="min-w-52">
                {data.workspaceMemberships.length > 1 ? (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Team</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={data.workspace.id}
                      onValueChange={(value) => contextChanged(() => onWorkspaceChange(value))}
                    >
                      {data.workspaceMemberships.map((membership) => (
                        <DropdownMenuRadioItem
                          key={membership.workspaceId}
                          value={membership.workspaceId}
                        >
                          <span className="truncate">{membership.workspaceName}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                ) : null}
                {data.workspaceMemberships.length > 1 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Product</DropdownMenuLabel>
                  {data.products.length ? (
                    <DropdownMenuRadioGroup
                      value={data.currentProduct?.id ?? ""}
                      onValueChange={(value) => contextChanged(() => onProductChange(value))}
                    >
                      {data.products.map((product) => (
                        <DropdownMenuRadioItem key={product.id} value={product.id}>
                          <span className="truncate">{product.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  ) : (
                    <DropdownMenuItem disabled>No products</DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                {canCreateProduct ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => contextChanged(() => onNavigate("configuration"))}
                    >
                      New product
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div
              className={cn(
                "mr-10 flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-1 py-1 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                isCollapsed
                  ? "pointer-events-none -translate-x-1 opacity-0"
                  : "translate-x-0 opacity-100",
              )}
            >
              {contextIdentity}
            </div>
          )}
          <SidebarCollapseTrigger />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => {
                const active =
                  item.view === "configuration"
                    ? configurationViews.has(view)
                    : view === item.view || (item.view === "feedback" && view === "interactions");
                const count = item.count?.(data);
                return (
                  <SidebarMenuItem key={item.view}>
                    <SidebarMenuButton
                      type="button"
                      isActive={active}
                      tooltip={item.label}
                      aria-current={active ? "page" : undefined}
                      onClick={() => onNavigate(item.view)}
                      className="data-active:shadow-[inset_2px_0_0_var(--attention)]"
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {count !== undefined ? <SidebarMenuBadge>{count}</SidebarMenuBadge> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<SidebarMenuButton size="lg" tooltip={data.user.displayName} />}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium">
                  {userInitials}
                </span>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{data.user.displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">{data.user.handle}</span>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="grid gap-0.5 px-2 py-1.5">
                    <span className="truncate text-foreground">{data.user.displayName}</span>
                    <span className="truncate font-normal">
                      {data.user.email ?? data.user.handle}
                    </span>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => onNavigate("configuration")}>
                    <IconSettingsGear4 />
                    Configuration
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onLogout}>Sign out</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function DashboardShell({
  data,
  view,
  onNavigate,
  onWorkspaceChange,
  onProductChange,
  onLogout,
  children,
}: {
  data: DashboardData;
  view: DashboardView;
  onNavigate: (view: DashboardView) => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onProductChange: (productId: string) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const shellTitle: Record<DashboardView, string> = {
    home: "Home",
    feedback: "Feedback",
    sessions: "Sessions",
    configuration: "Product",
    setup: "Setup",
    policy: "Collection",
    connectors: "Connectors",
    team: "Team",
    interactions: "Interaction",
  };

  return (
    <SidebarProvider
      defaultOpen
      className="h-dvh min-h-0 overflow-hidden"
      style={{ "--sidebar-width": "14rem", "--sidebar-width-icon": "3.25rem" } as CSSProperties}
    >
      <AppSidebar
        data={data}
        view={view}
        onNavigate={onNavigate}
        onWorkspaceChange={onWorkspaceChange}
        onProductChange={onProductChange}
        onLogout={onLogout}
      />
      <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden bg-canvas">
        <PageHeader
          title={shellTitle[view]}
          meta={data.currentProduct?.name ?? "No product selected"}
        />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
