import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider, SidebarTrigger, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeCustomizer } from "@/components/theme-customizer";
import { Button } from "@/components/ui/button";
import { ChatViewerHost } from "@/components/chat/ChatViewerDrawer";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const nav = useNavigate();
  const signOut = async () => {
    await supabase.auth.signOut();
    nav({ to: "/auth" });
  };
  return (
    <SidebarProvider defaultOpen={false}>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-background px-4">
            <SidebarTrigger />
            <div className="ml-auto flex items-center gap-2">
              <ThemeCustomizer />
              <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </header>
          <div className="flex-1">
            <Outlet />
          </div>
          <ChatViewerHost />
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}