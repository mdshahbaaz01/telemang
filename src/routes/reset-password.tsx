import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Eye, EyeOff, Check, X, Mail } from "lucide-react";
import { requestPasswordReset } from "@/lib/password-reset.functions";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  useEffect(() => {
    // Supabase recovery links land here with a session already established
    // (either via URL hash or PKCE). Wait until a session exists.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setReady(true);
        if (data.session.user?.email) setEmail(data.session.user.email);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setReady(true);
        if (session?.user?.email) setEmail(session.user.email);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const checks = useMemo(
    () => ({
      length: password.length >= 8,
      upper: /[A-Z]/.test(password),
      lower: /[a-z]/.test(password),
      number: /\d/.test(password),
      symbol: /[^A-Za-z0-9]/.test(password),
    }),
    [password],
  );
  const passedCount = Object.values(checks).filter(Boolean).length;
  const allPassed = passedCount === 5;
  const matches = confirm.length > 0 && password === confirm;
  const strengthLabel = ["Very weak", "Weak", "Fair", "Good", "Strong", "Excellent"][passedCount];
  const strengthColor = ["bg-destructive", "bg-destructive", "bg-amber-500", "bg-amber-500", "bg-emerald-500", "bg-emerald-500"][passedCount];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allPassed) {
      toast.error("Password does not meet all requirements");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated. You are signed in.");
      nav({ to: "/dashboard" });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (!email) {
      toast.error("Enter your account email to resend the reset link");
      return;
    }
    setResending(true);
    try {
      const res = await requestPasswordReset({
        data: {
          email,
          redirectTo: `${window.location.origin}/reset-password`,
        },
      });
      if (!res.ok) {
        const secs = Math.max(1, res.retryAfter);
        const label =
          res.reason === "hourly_cap"
            ? `Hourly limit reached. Try again in ${formatWait(secs)}.`
            : `Please wait ${formatWait(secs)} before requesting another link.`;
        toast.error(label);
        setResendCooldown(secs);
        return;
      }
      toast.success("Reset email sent. Check your inbox.");
      setResendCooldown(res.retryAfter);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setResending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reset password</h1>
          <p className="text-sm text-muted-foreground">
            {ready
              ? "Enter a new password for your account."
              : "Open the reset link from your email to continue."}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pw">New password</Label>
          <div className="relative">
            <Input
              id="pw"
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              disabled={!ready}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pw2">Confirm new password</Label>
          <Input
            id="pw2"
            type={showPw ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={6}
            disabled={!ready}
          />
        </div>
        {password.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Strength</span>
              <span className="font-medium">{strengthLabel}</span>
            </div>
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded ${i < passedCount ? strengthColor : "bg-muted"}`}
                />
              ))}
            </div>
            <ul className="space-y-1 text-xs">
              <Req ok={checks.length} label="At least 8 characters" />
              <Req ok={checks.upper} label="One uppercase letter" />
              <Req ok={checks.lower} label="One lowercase letter" />
              <Req ok={checks.number} label="One number" />
              <Req ok={checks.symbol} label="One symbol" />
              {confirm.length > 0 && <Req ok={matches} label="Passwords match" />}
            </ul>
          </div>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={loading || !ready || !allPassed || !matches}
        >
          {loading ? "Updating…" : "Update password"}
        </Button>
        <div className="space-y-2 border-t border-border pt-4">
          <Label htmlFor="resend-email" className="text-xs text-muted-foreground">
            Need a new link?
          </Label>
          <div className="flex gap-2">
            <Input
              id="resend-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              onClick={resend}
              disabled={resending || resendCooldown > 0 || !email}
            >
              <Mail className="mr-1 h-4 w-4" />
              {resendCooldown > 0 ? `${resendCooldown}s` : resending ? "Sending…" : "Resend"}
            </Button>
          </div>
        </div>
      </form>
    </main>
  );
}

function Req({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 ${ok ? "text-emerald-500" : "text-muted-foreground"}`}>
      {ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
      <span>{label}</span>
    </li>
  );
}