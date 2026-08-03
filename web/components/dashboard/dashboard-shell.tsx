"use client";

import { IconChevronGrabberVertical } from "central-icons/IconChevronGrabberVertical";
import { IconConnectors1 } from "central-icons/IconConnectors1";
import { IconPeople } from "central-icons/IconPeople";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
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

const navigation: Array<{
  view: DashboardView;
  label: string;
  icon: NavigationIcon;
}> = [
  {
    view: "customers",
    label: "Customers",
    icon: IconPeople,
  },
  {
    view: "insights",
    label: "Insights",
    icon: IconSparkle,
  },
  {
    view: "setup",
    label: "Setup",
    icon: IconSettingsGear4,
  },
  {
    view: "connectors",
    label: "Connectors",
    icon: IconConnectors1,
  },
  { view: "policy", label: "Data controls", icon: IconShieldCheck },
];

const EDITOR_ONLY_VIEWS: ReadonlySet<DashboardView> = new Set(["setup", "connectors", "policy"]);

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
              {navigation
                .filter((item) => canCreateProduct || !EDITOR_ONLY_VIEWS.has(item.view))
                .map((item) => {
                  const active =
                    view === item.view ||
                    (item.view === "customers" &&
                      (view === "features" ||
                        view === "sessions" ||
                        view === "feedback" ||
                        view === "interactions"));
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
    insights: "Insights",
    customers: "Customers",
    features: "Features",
    feedback: "Evidence",
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
