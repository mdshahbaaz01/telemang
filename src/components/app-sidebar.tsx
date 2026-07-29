import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
  ChefHat,
  Image as ImageIcon,
  Eye,
  EyeOff,
  Pencil,
  Check,
  GripVertical,
  ShieldAlert,
  Gauge,
  Activity,
  Trophy,
  Flag,
  Globe,
  Forward,
  Send,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { Button } from "@/components/ui/button";

type Item = {
  id: string;
  title: string;
  to: string;
  search?: Record<string, string>;
  icon: React.ComponentType<{ className?: string }>;
  match?: (pathname: string, search: string) => boolean;
};

const items: Item[] = [
  { id: "dashboard", title: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { id: "owner", title: "Owner Panel", to: "/owner", icon: ShieldCheck },
  { id: "cleanup", title: "Cleanup", to: "/cleanup", icon: Brush },
  {
    id: "actions",
    title: "Actions",
    to: "/actions",
    icon: Radio,
    match: (p, s) => p === "/actions" && !s.includes("tab=broadcast"),
  },
  {
    id: "broadcast",
    title: "Broadcast",
    to: "/actions",
    search: { tab: "broadcast" },
    icon: Megaphone,
    match: (p, s) => p === "/actions" && s.includes("tab=broadcast"),
  },
  { id: "bot-flow", title: "Bot Flow", to: "/bot-flow", icon: Bot },
  { id: "bulk-mix", title: "Bulk Mix", to: "/bulk-mix", icon: Sparkles },
  { id: "profile-updater", title: "Profile Updater", to: "/profile-updater", icon: UserCog },
  { id: "search", title: "Global Search", to: "/search", icon: Search },
  { id: "workspace", title: "Workspace", to: "/workspace", icon: Columns },
  { id: "bulk-plus", title: "Bulk+", to: "/bulk-plus", icon: Rocket },
  { id: "bot-success", title: "Bot Success", to: "/bot-success", icon: Trophy },
  { id: "referrals", title: "Referrals", to: "/referrals", icon: Users },
  { id: "analytics", title: "Analytics", to: "/analytics", icon: BarChart3 },
  { id: "recipes", title: "Recipes", to: "/recipes", icon: ChefHat },
  { id: "watchlists", title: "Watchlists", to: "/watchlists", icon: Eye },
  { id: "stealth", title: "Stealth", to: "/stealth", icon: EyeOff },
  { id: "captcha", title: "Captcha Solver", to: "/captcha", icon: ShieldAlert },
  { id: "join-pacing", title: "Join Pacing", to: "/join-pacing", icon: Gauge },
  { id: "health", title: "Health", to: "/health", icon: Activity },
  { id: "report", title: "Bulk Report", to: "/report", icon: Flag },
  { id: "proxies", title: "Proxies", to: "/proxies", icon: Globe },
  { id: "forward-range", title: "Forward Range", to: "/forward-range", icon: Forward },
  { id: "join-requests", title: "Join Requests", to: "/join-requests", icon: Send },
];

// Owner-only items — always hidden from non-owner regardless of features.
const OWNER_ONLY_IDS = new Set(["owner"]);

const ORDER_KEY = "tm.sidebarOrder.v1";

function loadOrder(): string[] {
  if (typeof window === "undefined") return items.map((i) => i.id);
  try {
    const raw = window.localStorage.getItem(ORDER_KEY);
    if (!raw) return items.map((i) => i.id);
    const parsed = JSON.parse(raw) as string[];
    const known = new Set(items.map((i) => i.id));
    const filtered = parsed.filter((id) => known.has(id));
    // append any new items not yet in saved order
    for (const it of items) if (!filtered.includes(it.id)) filtered.push(it.id);
    return filtered;
  } catch {
    return items.map((i) => i.id);
  }
}

function SortableRow({
  item,
  active,
  editing,
}: {
  item: Item;
  active: boolean;
  editing: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: !editing });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const Icon = item.icon;
  return (
    <SidebarMenuItem ref={setNodeRef} style={style}>
      <SidebarMenuButton
        asChild={!editing}
        isActive={active}
        tooltip={item.title}
        className="group/nav transition-all duration-300 ease-out hover:!bg-[#5353ff] hover:!text-white hover:translate-x-[1px] hover:-translate-y-[1px] active:scale-[0.99]"
      >
        {editing ? (
          <div
            className="flex w-full items-center gap-2 cursor-grab active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4 opacity-60" />
            <Icon className="h-4 w-4" />
            <span className="font-semibold">{item.title}</span>
          </div>
        ) : (
          <Link
            to={item.to}
            search={item.search as never}
            className="flex items-center gap-2"
          >
            <Icon className="h-4 w-4 transition-all duration-300 ease-out group-hover/nav:stroke-white" />
            <span className="font-semibold">{item.title}</span>
          </Link>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const { pathname, search } = useRouterState({
    select: (r) => ({ pathname: r.location.pathname, search: r.location.searchStr }),
  });

  const [order, setOrder] = useState<string[]>(() => loadOrder());
  const [editing, setEditing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [isOwner, setIsOwner] = useState<boolean>(false);
  const [features, setFeatures] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOrder(loadOrder());
    setHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) {
        if (!cancelled) setIsAdmin(false);
        return;
      }
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userRes.user.id);
      if (cancelled) return;
      const roles = (data ?? []).map((r) => r.role);
      const owner = roles.includes("owner");
      setIsOwner(owner);
      setIsAdmin(owner || roles.includes("admin"));
      if (!owner) {
        const { data: fp } = await supabase
          .from("user_feature_permissions")
          .select("feature_key, allowed")
          .eq("user_id", userRes.user.id);
        const map: Record<string, boolean> = {};
        for (const r of fp ?? []) map[r.feature_key] = r.allowed;
        setFeatures(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    window.localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  }, [order, hydrated]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), []);
  const orderedItems = useMemo(
    () => {
      const all = order.map((id) => byId.get(id)).filter(Boolean) as Item[];
      if (isOwner) return all;
      // Single-owner UI: everyone (once authenticated) sees the same items
      // except the owner-only panel.
      return all.filter((i) => !OWNER_ONLY_IDS.has(i.id));
    },
    [order, byId, isOwner],
  );

  const isActive = (item: Item) =>
    item.match ? item.match(pathname, search) : pathname === item.to;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrder((cur) => {
      const oldIndex = cur.indexOf(String(active.id));
      const newIndex = cur.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return cur;
      return arrayMove(cur, oldIndex, newIndex);
    });
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-sm font-semibold tracking-tight">TeleManager Pro</span>
          <Button
            variant={editing ? "default" : "ghost"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setEditing((e) => !e)}
            title={editing ? "Done" : "Edit sidebar order"}
            aria-label={editing ? "Done editing sidebar" : "Edit sidebar order"}
          >
            {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {isAdmin !== false && <SidebarGroup>
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
        </SidebarGroup>}
        <SidebarGroup>
          <SidebarGroupLabel>
            {editing ? "Drag to reorder" : "Navigation"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext items={order} strategy={verticalListSortingStrategy}>
                  {orderedItems.map((item) => (
                    <SortableRow
                      key={item.id}
                      item={item}
                      active={isActive(item)}
                      editing={editing}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}