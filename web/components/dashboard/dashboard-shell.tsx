"use client";

import { IconChatBubbles } from "central-icons/IconChatBubbles";
import { IconFootsteps } from "central-icons/IconFootsteps";
import { IconChevronGrabberVertical } from "central-icons/IconChevronGrabberVertical";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconHome } from "central-icons/IconHome";
import { IconPeople } from "central-icons/IconPeople";
import { IconPlugin2 } from "central-icons/IconPlugin2";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
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

import { DASHBOARD_CONFIGURATION_VIEWS, type DashboardView } from "./types";

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
    view: "home",
    label: "Home",
    icon: IconHome,
  },
  {
    view: "sessions",
    label: "Journeys",
    icon: IconFootsteps,
  },
  {
    view: "customers",
    label: "Customers",
    icon: IconPeople,
  },
  {
    view: "responses",
    label: "Responses",
    icon: IconChatBubbles,
  },
  {
    view: "questions",
    label: "Questions",
    icon: IconCircleQuestionmark,
  },
  {
    view: "connectors",
    label: "Connectors",
    icon: IconPlugin2,
  },
  {
    view: "configuration",
    label: "Configurations",
    icon: IconSettingsGear4,
  },
];

const CONFIGURATION_VIEWS: ReadonlySet<DashboardView> = new Set(DASHBOARD_CONFIGURATION_VIEWS);

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
  const canOpenProductMenu =
    canCreateProduct || data.workspaceMemberships.length > 1 || data.products.length > 1;

  function productSelectionChanged(change: () => void) {
    change();
    if (isMobile) setOpenMobile(false);
  }

  const productIdentity = (
    <>
      <EpodeMark />
      <div className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-medium">{productName}</span>
        <span className="truncate text-xs text-muted-foreground">{data.workspace.name}</span>
      </div>
      {canOpenProductMenu ? (
        <IconChevronGrabberVertical
          size={16}
          className="shrink-0 text-muted-foreground"
          data-icon="product-menu-chevron"
        />
      ) : null}
    </>
  );

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="h-10 shrink-0 justify-center border-b px-2 py-0">
        <div className="relative flex h-7 w-full items-center">
          {canOpenProductMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${productName}, ${data.workspace.name} - open product menu`}
                    className={cn(
                      "group/product-menu mr-10 flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-1 py-1 text-left transition-[opacity,transform,background-color] duration-150 ease-out hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent motion-reduce:transition-none",
                      isCollapsed
                        ? "pointer-events-none -translate-x-1 opacity-0"
                        : "translate-x-0 opacity-100",
                    )}
                  />
                }
              >
                {productIdentity}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={6} className="min-w-52">
                {data.workspaceMemberships.length > 1 ? (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Team</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={data.workspace.id}
                      onValueChange={(value) =>
                        productSelectionChanged(() => onWorkspaceChange(value))
                      }
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
                      onValueChange={(value) =>
                        productSelectionChanged(() => onProductChange(value))
                      }
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
                      onClick={() => productSelectionChanged(() => onNavigate("configuration"))}
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
              {productIdentity}
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
                .filter(
                  (item) =>
                    (item.view !== "connectors" && item.view !== "questions") || canCreateProduct,
                )
                .map((item) => {
                  const active =
                    view === item.view ||
                    (item.view === "configuration" && CONFIGURATION_VIEWS.has(view)) ||
                    (item.view === "responses" && view === "feedback") ||
                    (item.view === "sessions" && view === "interactions");
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
                    Configurations
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
    customers: "Customers",
    responses: "Responses",
    feedback: "Response",
    sessions: "Journeys",
    configuration: "Configurations",
    policy: "Configurations",
    questions: "Questions",
    connectors: "Connectors",
    team: "Configurations",
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
