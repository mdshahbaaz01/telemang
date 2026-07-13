import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Eye, EyeOff, Check, X, Mail } from "lucide-react";
import { peekPasswordResetCooldown, requestPasswordReset } from "@/lib/password-reset.functions";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(v: string) {
  return v.trim().toLowerCase();
}
function mapAuthError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("same_password") || m.includes("should be different"))
    return "New password must be different from your current password.";
  if (m.includes("weak") || m.includes("password should"))
    return "Password is too weak. Choose a longer, more complex password.";
  if (m.includes("session") || m.includes("jwt") || m.includes("expired"))
    return "Your reset link expired. Request a new one below.";
  if (m.includes("rate") || m.includes("too many"))
    return "Too many attempts. Please wait a moment and try again.";
  if (m.includes("network") || m.includes("fetch"))
    return "Network error. Check your connection and try again.";
  return msg || "Something went wrong. Please try again.";
}

function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.ceil(seconds / 60);
  return `${m} min`;
}

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
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

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
        const e = data.session.user?.email;
        if (e) {
          setEmail(e);
          void refreshCooldown(e);
        }
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setReady(true);
        const e = session?.user?.email;
        if (e) {
          setEmail(e);
          void refreshCooldown(e);
        }
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshCooldown = async (rawEmail: string) => {
    const normalized = normalizeEmail(rawEmail);
    if (!EMAIL_RE.test(normalized)) return;
    try {
      const res = await peekPasswordResetCooldown({ data: { email: normalized } });
      if (res.retryAfter > 0) setResendCooldown(res.retryAfter);
    } catch {
      // non-fatal — cooldown will re-sync on next send attempt
    }
  };

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
    setUpdateError(null);
    if (!allPassed) {
      setUpdateError("Password does not meet all requirements.");
      return;
    }
    if (password !== confirm) {
      setUpdateError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated. You are signed in.");
      nav({ to: "/dashboard" });
    } catch (err) {
      setUpdateError(mapAuthError((err as Error).message));
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    setResendError(null);
    setResendInfo(null);
    setEmailError(null);
    const normalized = normalizeEmail(email);
    if (!normalized) {
      setEmailError("Enter your account email to resend the reset link.");
      return;
    }
    if (!EMAIL_RE.test(normalized) || normalized.length > 255) {
      setEmailError("Enter a valid email address.");
      return;
    }
    if (normalized !== email) setEmail(normalized);
    setResending(true);
    try {
      const res = await requestPasswordReset({
        data: {
          email: normalized,
          redirectTo: `${window.location.origin}/reset-password`,
        },
      });
      if (!res.ok) {
        const secs = Math.max(1, res.retryAfter);
        setResendError(
          res.reason === "hourly_cap"
            ? `Hourly limit reached. Try again in ${formatWait(secs)}.`
            : res.reason === "server_error"
              ? "Couldn't send the reset email right now. Please try again shortly."
              : `Please wait ${formatWait(secs)} before requesting another link.`,
        );
        setResendCooldown(secs);
        return;
      }
      setResendInfo("Reset email sent. Check your inbox.");
      setResendCooldown(res.retryAfter);
    } catch (err) {
      setResendError(mapAuthError((err as Error).message));
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
        {updateError && (
          <p role="alert" className="text-sm text-destructive">{updateError}</p>
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
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError(null);
              }}
              onBlur={(e) => {
                const v = normalizeEmail(e.target.value);
                if (v && v !== e.target.value) setEmail(v);
                if (v && EMAIL_RE.test(v)) void refreshCooldown(v);
              }}
              aria-invalid={!!emailError}
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
          {emailError && (
            <p role="alert" className="text-xs text-destructive">{emailError}</p>
          )}
          {resendError && (
            <p role="alert" className="text-xs text-destructive">{resendError}</p>
          )}
          {resendInfo && !resendError && (
            <p className="text-xs text-emerald-500">{resendInfo}</p>
          )}
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