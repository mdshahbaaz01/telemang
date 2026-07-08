import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { getMyRole } from "@/lib/roles.functions";
import { Button } from "@/components/ui/button";

export function useMyRole() {
  const fn = useServerFn(getMyRole);
  return useQuery({
    queryKey: ["my-role"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
}

export function AdminGate({ children }: { children: React.ReactNode }) {
  const nav = useNavigate();
  const q = useMyRole();

  if (q.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Checking access…</p>
      </main>
    );
  }
  if (q.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold">Failed to verify access</h1>
          <p className="text-sm text-muted-foreground">{(q.error as Error).message}</p>
          <Button onClick={() => q.refetch()}>Retry</Button>
        </div>
      </main>
    );
  }
  if (!q.data?.isAdmin) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-xl font-semibold">Admins only</h1>
          <p className="text-sm text-muted-foreground">
            This app is restricted to admins. Ask an existing admin to promote your account.
          </p>
          <Button
            variant="outline"
            onClick={async () => {
              await supabase.auth.signOut();
              nav({ to: "/auth" });
            }}
          >
            Sign out
          </Button>
        </div>
      </main>
    );
  }
  return <>{children}</>;
}
