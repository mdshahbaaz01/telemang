import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider, SidebarTrigger, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { Button } from "@/components/ui/button";
import { ChatViewerHost } from "@/components/chat/ChatViewerDrawer";
import { FavoritesBar } from "@/components/FavoritesBar";
import { useEffect } from "react";
import { startSessionHeartbeat } from "@/lib/session-heartbeat";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    // Fetch role client-side so children beforeLoad can gate synchronously.
    let isAdmin = false;
    let isOwner = false;
    const features: Record<string, boolean> = {};
    try {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", data.user.id);
      const rs = (roles ?? []).map((r) => r.role);
      isOwner = rs.includes("owner");
      isAdmin = isOwner || rs.includes("admin");
      if (!isOwner) {
        const { data: fp } = await supabase
          .from("user_feature_permissions")
          .select("feature_key, allowed")
          .eq("user_id", data.user.id);
        for (const r of fp ?? []) features[r.feature_key] = r.allowed;
      }
    } catch {
      // fail-closed
    }
    return { user: data.user, isAdmin, isOwner, features };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const nav = useNavigate();
  useEffect(() => {
    startSessionHeartbeat();
  }, []);
  const signOut = async () => {
    await supabase.auth.signOut();
    nav({ to: "/auth" });
  };
  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-hairline bg-background/70 px-4 backdrop-blur-md">
            <SidebarTrigger />
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-2 w-2 rounded-full bg-primary shadow-[0_0_10px_var(--primary)]" />
              <span className="truncate font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                Tele<span className="gold-gradient-text">Manager</span>
              </span>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ThemeCustomizer />
              <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </header>
          <div className="min-w-0 flex-1 overflow-x-hidden">
            <FavoritesBar />
            <Outlet />
          </div>
          <ChatViewerHost />
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}