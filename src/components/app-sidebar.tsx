import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  ShieldCheck,
  Brush,
  Radio,
  Megaphone,
  Bot,
  BellRing,
  Plus,
  MousePointerClick,
  UserCog,
  Sparkles,
  Search,
  Cpu,
  Users,
  BarChart3,
  Columns,
  Rocket,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type Item = {
  title: string;
  to: string;
  search?: Record<string, string>;
  icon: React.ComponentType<{ className?: string }>;
  match?: (pathname: string, search: string) => boolean;
};

const items: Item[] = [
  { title: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { title: "Owner Panel", to: "/owner", icon: ShieldCheck },
  { title: "Cleanup", to: "/cleanup", icon: Brush },
  {
    title: "Actions",
    to: "/actions",
    icon: Radio,
    match: (p, s) => p === "/actions" && !s.includes("tab=broadcast"),
  },
  {
    title: "Broadcast",
    to: "/actions",
    search: { tab: "broadcast" },
    icon: Megaphone,
    match: (p, s) => p === "/actions" && s.includes("tab=broadcast"),
  },
  { title: "Bot Flow", to: "/bot-flow", icon: Bot },
  { title: "Alerts", to: "/alerts", icon: BellRing },
  { title: "Buttons", to: "/buttons", icon: MousePointerClick },
  { title: "Bulk Mix", to: "/bulk-mix", icon: Sparkles },
  { title: "Profile Updater", to: "/profile-updater", icon: UserCog },
  { title: "Global Search", to: "/search", icon: Search },
  { title: "Workspace", to: "/workspace", icon: Columns },
  { title: "Bulk+", to: "/bulk-plus", icon: Rocket },
  { title: "Bot Parser", to: "/bot-parser", icon: Cpu },
  { title: "Referrals", to: "/referrals", icon: Users },
  { title: "Analytics", to: "/analytics", icon: BarChart3 },
];

export function AppSidebar() {
  const { pathname, search } = useRouterState({
    select: (r) => ({ pathname: r.location.pathname, search: r.location.searchStr }),
  });

  const isActive = (item: Item) =>
    item.match ? item.match(pathname, search) : pathname === item.to;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="px-2 py-1.5 text-sm font-semibold tracking-tight">
          TeleManager Pro
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item)}
                    tooltip={item.title}
                    className="group/nav transition-all duration-300 ease-out hover:!bg-[#5353ff] hover:!text-white hover:translate-x-[1px] hover:-translate-y-[1px] active:scale-[0.99]"
                  >
                    <Link
                      to={item.to}
                      search={item.search as never}
                      className="flex items-center gap-2"
                    >
                      <item.icon className="h-4 w-4 transition-all duration-300 ease-out group-hover/nav:stroke-white" />
                      <span className="font-semibold">{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Create</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="New Task"
                  isActive={pathname === "/tasks/new"}
                  className="group/nav text-[#bd89ff] transition-all duration-300 ease-out hover:!bg-[rgba(56,45,71,0.836)] hover:!text-[#bd89ff] hover:translate-x-[1px] hover:-translate-y-[1px] active:scale-[0.99]"
                >
                  <Link to="/tasks/new" className="flex items-center gap-2">
                    <Plus className="h-4 w-4 stroke-[#bd89ff]" />
                    <span className="font-semibold">New Task</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}