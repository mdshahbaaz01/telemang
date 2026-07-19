import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTelegramWebviewBridge } from "@/lib/telegram-webview-bridge";
import { supabase } from "@/integrations/supabase/client";
import { listAccounts } from "@/lib/accounts.functions";
import { openStartAppLink, joinFromLink, extractVerifyLink } from "@/lib/tg-viewer.functions";
import { previewChat } from "@/lib/chat-viewer.functions";
import { useMiniAppProxyUrl } from "@/lib/miniapp-proxy-url";
import { AdminGate } from "@/components/AdminGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Play, Square, ArrowLeft, Loader2, RefreshCw, X, MessageSquare, Copy, ExternalLink } from "lucide-react";
import { BrowserPickerButton } from "@/components/BrowserPickerButton";
import { AccountIdPaste } from "@/components/AccountIdPaste";
import { copyWithToast } from "@/lib/clipboard";
import { useBotFlowCaptchaConfig, CAPTCHA_KIND_OPTIONS, CAPTCHA_PROVIDER_OPTIONS } from "@/lib/bot-flow-captcha-config";
import { CaptchaErrorBoundary } from "@/components/CaptchaErrorBoundary";
import { PreJoinCard } from "@/components/PreJoinCard";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { VirtualList } from "@/components/VirtualList";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { requireAdminBeforeLoad } from "@/lib/access-guard";

export const Route = createFileRoute("/_authenticated/bot-flow")({
  beforeLoad: requireAdminBeforeLoad,
  component: () => (
    <AdminGate>
      <BotFlowPage />
    </AdminGate>
  ),
});

type LogEntry = {
  accountId?: string;
  level: "info" | "success" | "warn" | "error";
  target?: string;
  message: string;
  ts: number;
};

type JoinState = {
  total: number;
  joined: number;
  remaining: number;
  remainingList: string[];
  round?: number;
  stopped?: boolean;
  reason?: string;
};

type VerifyLinkSession = {
  hasInitData: boolean;
  userId?: string;
  userLabel?: string;
  error?: string;
};

function parseVerifyLinkSession(rawUrl: string): VerifyLinkSession {
  if (!rawUrl) return { hasInitData: false };
  try {
    const url = new URL(rawUrl);
    const launchParams = new URLSearchParams(String(url.hash || "").replace(/^#/, ""));
    const initData = launchParams.get("tgWebAppData") || url.searchParams.get("tgWebAppData");
    if (!initData) return { hasInitData: false };

    const initParams = new URLSearchParams(initData);
    const userRaw = initParams.get("user");
    if (!userRaw) return { hasInitData: true, error: "No user found in Telegram session data" };

    const user = JSON.parse(userRaw) as {
      id?: string | number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    const userId = user.id != null ? String(user.id) : undefined;
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return {
      hasInitData: true,
      userId,
      userLabel: user.username ? `@${user.username}` : displayName || undefined,
    };
  } catch (e) {
    return { hasInitData: false, error: (e as Error).message };
  }
}

function BotFlowPage() {
  const listAcc = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listAcc() });
  const openStartApp = useServerFn(openStartAppLink);
  const extractVerifyFn = useServerFn(extractVerifyLink);

  const [referLink, setReferLink] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fetchBotAccountId, setFetchBotAccountId] = useState<string>("");
  const [autoJoinRequired, setAutoJoinRequired] = useState(true);
  const [publicInviteFallback, setPublicInviteFallback] = useState(true);
  const [runParallel, setRunParallel] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [totals, setTotals] = useState<{ ok: number; fail: number } | null>(null);
  const [joinState, setJoinState] = useState<Record<string, JoinState>>({});
  const [runStartAt, setRunStartAt] = useState<number | null>(null);
  const [accountsDone, setAccountsDone] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [accountsTotal, setAccountsTotal] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const BOT_CHANNELS_KEY = "botflow.channels.byBot.v1";
  const BOT_CHANNELS_LAST_KEY = "botflow.channels.lastBot.v1";
  const [botChannelsMap, setBotChannelsMap] = useState<Record<string, string[]>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(BOT_CHANNELS_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  });
  const [lastBotKey, setLastBotKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(BOT_CHANNELS_LAST_KEY) ?? ""; } catch { return ""; }
  });
  const [showBotChannels, setShowBotChannels] = useState(false);
  const [fetchingBotChannels, setFetchingBotChannels] = useState(false);
  const previewChatFn = useServerFn(previewChat);
  useEffect(() => {
    try { window.localStorage.setItem(BOT_CHANNELS_KEY, JSON.stringify(botChannelsMap)); } catch {}
  }, [botChannelsMap]);
  useEffect(() => {
    try { if (lastBotKey) window.localStorage.setItem(BOT_CHANNELS_LAST_KEY, lastBotKey); } catch {}
  }, [lastBotKey]);
  const abortRef = useRef<AbortController | null>(null);

  const accountList = accountsQ.data ?? [];
  const allIds = useMemo(() => accountList.map((a) => a.id), [accountList]);

  // Parse a bot referral link/handle preview for the user.
  const parsed = useMemo(() => {
    const raw = referLink.trim();
    if (!raw) return null;
    try {
      let username = "";
      let startParam = "";
      if (raw.startsWith("@")) {
        username = raw.slice(1);
      } else if (raw.includes("t.me/") || raw.startsWith("http")) {
        const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
        username = url.pathname.replace(/^\/+/, "").split("/")[0];
        startParam = url.searchParams.get("start") || url.searchParams.get("startapp") || "";
      } else {
        username = raw;
      }
      return { username, startParam };
    } catch {
      return { username: raw, startParam: "" };
    }
  }, [referLink]);

  const runningBotKeyRef = useRef<string>("");
  const currentBotKey = (parsed?.username || lastBotKey || "").toLowerCase();
  const botChannels = useMemo(
    () => new Set<string>(currentBotKey ? botChannelsMap[currentBotKey] ?? [] : []),
    [botChannelsMap, currentBotKey],
  );
  const addChannelsToCurrentBot = (chans: string[]) => {
    const key = (runningBotKeyRef.current || currentBotKey).toLowerCase();
    if (!key || !chans.length) return;
    setBotChannelsMap((prev) => {
      const existing = new Set(prev[key] ?? []);
      for (const c of chans) if (c) existing.add(c);
      return { ...prev, [key]: Array.from(existing) };
    });
  };
  const clearCurrentBotChannels = () => {
    const key = currentBotKey;
    if (!key) return;
    setBotChannelsMap((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addLog = (l: Omit<LogEntry, "ts">) =>
    setLogs((prev) => [{ ...l, ts: Date.now() }, ...prev].slice(0, 500));

  const toggle = (id: string) =>
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const readStream = async (res: Response) => {
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      const message = `Stream failed: ${res.status}${t ? ` — ${t}` : ""}`;
      addLog({ level: "error", message });
      toast.error(message);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const evLine = chunk.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!evLine || !dataLine) continue;
        const event = evLine.slice(7).trim();
        let data: any = {};
        try { data = JSON.parse(dataLine.slice(6)); } catch {}
        if (event === "start") addLog({ level: "info", message: "Run started" });
        else if (event === "log") {
          const msg: string = data.message ?? "";
          const m = msg.match(/(@[A-Za-z0-9_]{4,}|\+[A-Za-z0-9_-]{6,}|t\.me\/[A-Za-z0-9_+/-]+)/gi);
          if (m && /Joined|Verified|Pre-join|pending|Skip |already/i.test(msg)) {
            addChannelsToCurrentBot(m.map((c) => c.replace(/^t\.me\//i, "")));
          }
          addLog({ accountId: data.accountId, level: data.level ?? "info", target: data.target, message: msg });
        }
        else if (event === "done") addLog({ accountId: data.accountId, level: data.fail ? "warn" : "info", message: `Account done — ok ${data.ok}, fail ${data.fail}` });
        if (event === "done") setAccountsDone((n) => n + 1);
        else if (event === "joinProgress") {
          if (Array.isArray(data.remainingList) && data.remainingList.length) {
            addChannelsToCurrentBot(data.remainingList as string[]);
          }
          setJoinState((prev) => ({
            ...prev,
            [data.accountId]: {
              total: data.total ?? 0,
              joined: data.joined ?? 0,
              remaining: data.remaining ?? 0,
              remainingList: data.remainingList ?? [],
              round: data.round,
              stopped: false,
            },
          }));
        }
        else if (event === "joinStop") {
          setJoinState((prev) => ({
            ...prev,
            [data.accountId]: {
              total: data.total ?? 0,
              joined: data.joined ?? 0,
              remaining: data.remaining ?? 0,
              remainingList: data.remainingList ?? [],
              round: data.round,
              stopped: true,
              reason: data.reason,
            },
          }));
        }
        else if (event === "end") {
          setTotals({ ok: data.ok ?? 0, fail: data.fail ?? 0 });
          const message = `Finished — ok ${data.ok}, fail ${data.fail}`;
          if (data.fail) toast.warning(message); else toast.success(message);
        } else if (event === "aborted") addLog({ level: "warn", message: data.message ?? "Stopped" });
      }
    }
  };

  const run = async () => {
    const link = referLink.trim();
    if (!link) return toast.error("Paste a bot referral link");
    const accountIds = selectedIds.length ? selectedIds : allIds;
    if (!accountIds.length) return toast.error("Select at least one account");

    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return toast.error("Not signed in");

    setLogs([]);
    setTotals(null);
    setJoinState({});
    setAccountsDone(0);
    setAccountsTotal(accountIds.length);
    setRunStartAt(Date.now());
    setRunning(true);
    const botKey = (parsed?.username || "").toLowerCase();
    runningBotKeyRef.current = botKey;
    if (botKey) setLastBotKey(botKey);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/public/actions-stream", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          accountIds,
          minDelay: 1,
          maxDelay: 2,
          concurrency: runParallel ? Math.max(1, accountIds.length) : 1,
          op: {
            kind: "botflow",
            bot: link,
            // A no-op step keeps the server schema happy; /start (with the ref
            // param parsed from the link) is fired before steps run, so the
            // referrer is already credited by then.
            steps: ["wait:2"],
            autoJoinRequired,
            maxJoinRounds: 10,
            publicInviteFallback,
            parallel: runParallel,
          },
        }),
        signal: ac.signal,
      });
      await readStream(res);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const message = (e as Error).message;
        addLog({ level: "error", message });
        toast.error(message);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  // ─── Mini App (startapp) launcher ────────────────────────────────────
  const [miniLink, setMiniLink] = useState("");
  const [miniSelected, setMiniSelected] = useState<string[]>([]);
  const [miniRuns, setMiniRuns] = useState<
    { accountId: string; status: "loading" | "ready" | "error"; url?: string; error?: string }[]
  >([]);

  const miniParsed = useMemo(() => {
    const raw = miniLink.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      const path = url.pathname.replace(/^\/+/, "").split("/");
      const username = path[0]?.replace(/^@/, "") ?? "";
      const appShortName = path[1] ?? "";
      const startParam =
        url.searchParams.get("startapp") ||
        url.searchParams.get("start") ||
        "";
      return { username, startParam, appShortName };
    } catch {
      return null;
    }
  }, [miniLink]);

  const miniToggle = (id: string) =>
    setMiniSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const resolveOne = async (accountId: string, username: string, startParam: string) => {
    setMiniRuns((prev) => {
      const others = prev.filter((r) => r.accountId !== accountId);
      return [...others, { accountId, status: "loading" }];
    });
    try {
      const res = await openStartApp({
        data: { accountId, botUsername: username, startParam: startParam || undefined },
      });
      if (!res?.url) throw new Error("Telegram returned no URL");
      setMiniRuns((prev) =>
        prev.map((r) => (r.accountId === accountId ? { ...r, status: "ready", url: res.url } : r)),
      );
    } catch (e) {
      setMiniRuns((prev) =>
        prev.map((r) =>
          r.accountId === accountId
            ? { ...r, status: "error", error: (e as Error).message || "Failed" }
            : r,
        ),
      );
    }
  };

  const runMini = async () => {
    if (!miniParsed?.username) return toast.error("Paste a mini app link (t.me/bot?startapp=CODE)");
    const ids = miniSelected.length ? miniSelected : allIds;
    if (!ids.length) return toast.error("Select at least one account");
    setMiniRuns(ids.map((id) => ({ accountId: id, status: "loading" as const })));
    await Promise.all(ids.map((id) => resolveOne(id, miniParsed.username, miniParsed.startParam)));
  };

  const closeMini = (accountId: string) =>
    setMiniRuns((prev) => prev.filter((r) => r.accountId !== accountId));
  const clearMini = () => setMiniRuns([]);

  // ─── Verify-link extractor ───────────────────────────────────────
  const [vxLink, setVxLink] = useState("");
  const [vxButtonText, setVxButtonText] = useState("verify");
  const [vxSelected, setVxSelected] = useState<string[]>([]);
  const [vxRunning, setVxRunning] = useState(false);
  const [vxResults, setVxResults] = useState<
    { accountId: string; status: "loading" | "ready" | "error"; url?: string; label?: string; kind?: "webview" | "url"; error?: string }[]
  >([]);

  const vxParsed = useMemo(() => {
    const raw = vxLink.trim();
    if (!raw) return null;
    try {
      let username = "";
      let startParam = "";
      if (raw.startsWith("@")) username = raw.slice(1);
      else if (raw.includes("t.me/") || raw.startsWith("http")) {
        const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
        username = url.pathname.replace(/^\/+/, "").split("/")[0];
        startParam = url.searchParams.get("start") || url.searchParams.get("startapp") || "";
      } else username = raw;
      return { username, startParam };
    } catch { return { username: raw, startParam: "" }; }
  }, [vxLink]);

  const vxToggle = (id: string) =>
    setVxSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const runExtractVerify = async () => {
    if (!vxParsed?.username) return toast.error("Paste a bot link or @username");
    const ids = vxSelected.length ? vxSelected : allIds;
    if (!ids.length) return toast.error("Select at least one account");
    setVxRunning(true);
    setVxResults(ids.map((id) => ({ accountId: id, status: "loading" as const })));
    await Promise.all(
      ids.map(async (accountId) => {
        try {
          const res = await extractVerifyFn({
            data: {
              accountId,
              botUsername: vxParsed.username,
              startParam: vxParsed.startParam || undefined,
              buttonText: vxButtonText.trim() || "verify",
              sendStart: true,
            },
          });
          setVxResults((prev) =>
            prev.map((r) =>
              r.accountId === accountId
                ? { ...r, status: "ready", url: res.url, label: res.label, kind: res.kind }
                : r,
            ),
          );
        } catch (e) {
          setVxResults((prev) =>
            prev.map((r) =>
              r.accountId === accountId
                ? { ...r, status: "error", error: (e as Error).message || "Failed" }
                : r,
            ),
          );
        }
      }),
    );
    setVxRunning(false);
  };

  const copyAllVerify = async () => {
    const lines = vxResults
      .filter((r) => r.status === "ready" && r.url)
      .map((r) => {
        const acc = accountList.find((a) => a.id === r.accountId);
        const who = acc?.first_name || acc?.username || acc?.phone || r.accountId.slice(0, 8);
        return `${who}\t${r.url}`;
      });
    if (!lines.length) return toast.error("No links yet");
    await copyWithToast(lines.join("\n"), toast, `Copied ${lines.length} link(s)`);
  };

  // ─── Direct verification link runner ───────────────────────────────
  const [verifyLink, setVerifyLink] = useState("");
  const [verifyAccountId, setVerifyAccountId] = useState("");
  const [verifyNonce, setVerifyNonce] = useState(0);

  const normalizedVerifyLink = useMemo(() => {
    const raw = verifyLink.trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${raw}`;
  }, [verifyLink]);

  const selectedVerifyAccount = useMemo(
    () => accountList.find((a) => a.id === verifyAccountId) ?? null,
    [accountList, verifyAccountId],
  );
  const verifySession = useMemo(
    () => parseVerifyLinkSession(normalizedVerifyLink),
    [normalizedVerifyLink],
  );
  const verifyAccountTelegramId =
    selectedVerifyAccount?.telegram_user_id != null
      ? String(selectedVerifyAccount.telegram_user_id)
      : "";
  const verifyLinkAccountMismatch = Boolean(
    verifySession.userId && verifyAccountTelegramId && verifySession.userId !== verifyAccountTelegramId,
  );

  const openVerification = () => {
    if (!normalizedVerifyLink) return toast.error("Paste the verification link");
    if (!verifyAccountId) return toast.error("Select one account");
    try {
      new URL(normalizedVerifyLink);
      if (verifyLinkAccountMismatch) {
        return toast.error(
          "This verification URL is already signed for a different Telegram account. Use the original t.me mini-app link for this account.",
        );
      }
      setVerifyNonce((n) => n + 1);
    } catch {
      toast.error("Invalid verification URL");
    }
  };

  // ─── Per-account inline chat boxes for the refer bot ──────────────
  const [chatOpen, setChatOpen] = useState<string[]>([]);
  const [chatVisibleCount, setChatVisibleCount] = useState(1);
  const openChats = () => {
    if (!parsed?.username) return toast.error("Paste a bot referral link first");
    const ids = selectedIds.length ? selectedIds : allIds;
    if (!ids.length) return toast.error("Select at least one account");
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    setChatVisibleCount(isMobile ? 1 : ids.length);
    setChatOpen(ids);
  };
  const closeChat = (id: string) =>
    setChatOpen((prev) => prev.filter((x) => x !== id));
  const clearChats = () => {
    setChatOpen([]);
    setChatVisibleCount(1);
  };
  const visibleChatIds = chatOpen.slice(0, chatVisibleCount);
  const queuedChatCount = Math.max(0, chatOpen.length - visibleChatIds.length);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
        <Link to="/dashboard" className="inline-flex items-center gap-1 text-sm text-primary underline">
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Bot Flow</h1>

        <PreJoinCard accounts={accountList} />

        <CaptchaErrorBoundary scope="bot-flow-card" autoDisable>
          <BotFlowCaptchaCard />
        </CaptchaErrorBoundary>

        <CollapsibleSection storageKey="botflow.run" title="Run a bot with your referral link">

          <div>
            <Label>Bot referral link</Label>
            <Input
              value={referLink}
              onChange={(e) => setReferLink(e.target.value)}
              placeholder="https://t.me/somebot?start=YOUR_REF_CODE"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Paste your full referral URL. Every selected account will
              <code className="mx-1">/start</code>
              the bot using this link, so the refer count goes to your ref code.
            </p>
            {parsed?.username && (
              <div className="mt-2 text-xs text-muted-foreground">
                Bot: <span className="font-mono text-foreground">@{parsed.username}</span>
                <button
                  type="button"
                  className="ml-1 rounded p-0.5 align-middle hover:bg-muted"
                  title="Copy link"
                  onClick={() => copyWithToast(referLink.trim(), toast)}
                >
                  <Copy className="inline h-3 w-3" />
                </button>
                {parsed.startParam ? (
                  <>
                    {" "}· Ref code:{" "}
                    <span className="font-mono text-foreground">{parsed.startParam}</span>
                  </>
                ) : (
                  <span className="text-yellow-600 dark:text-yellow-400">
                    {" "}· No <code>start</code> code found in the link
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium mr-auto">
                {selectedIds.length} / {allIds.length} accounts selected
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setSelectedIds(allIds)}>Select all</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setSelectedIds([])}>Deselect all</Button>
            </div>

            <AccountIdPaste
              accounts={accountList}
              onSelect={(ids) =>
                setSelectedIds((prev) => Array.from(new Set([...prev, ...ids])))
              }
            />

            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-72 overflow-auto rounded-md border border-border p-2">
              {accountList.map((a) => {
                const checked = selectedIds.includes(a.id);
                return (
                  <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40">
                    <input type="checkbox" checked={checked} onChange={() => toggle(a.id)} />
                    <span className="truncate">{a.first_name || a.username || a.phone}</span>
                  </label>
                );
              })}
              {accountList.length === 0 && (
                <p className="text-xs text-muted-foreground">No accounts yet.</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={run} disabled={running || allIds.length === 0}>
              <Play className="mr-1 h-4 w-4" /> Run flow
            </Button>
            <Button variant="destructive" onClick={stop} disabled={!running}>
              <Square className="mr-1 h-4 w-4" /> Stop
            </Button>
            <label className="flex items-center gap-2 self-center text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoJoinRequired}
                onChange={(e) => setAutoJoinRequired(e.target.checked)}
              />
              Auto-join required channels & re-run /start
            </label>
            <label className="flex items-center gap-2 self-center text-xs text-muted-foreground" title="If an invite link (t.me/+hash) fails with INVITE_HASH_INVALID / EXPIRED / CHANNEL_PRIVATE, peek it and join the channel by its @username when it is actually public.">
              <input
                type="checkbox"
                checked={publicInviteFallback}
                onChange={(e) => setPublicInviteFallback(e.target.checked)}
              />
              Public invite auto-join fallback
            </label>
            <label
              className="flex items-center gap-2 self-center text-xs text-muted-foreground"
              title="Fire the /start + auto-join flow on every selected account at the same time. Faster but more likely to trigger FloodWait when many accounts try to join the same required channel at once."
            >
              <input
                type="checkbox"
                checked={runParallel}
                onChange={(e) => setRunParallel(e.target.checked)}
              />
              Run all accounts in parallel
            </label>
            {totals && (
              <div className="ml-auto self-center whitespace-nowrap text-sm text-muted-foreground">
                ok {totals.ok} · fail {totals.fail}
              </div>
            )}
          </div>

          {parsed?.username && (
            <div className="rounded-md border border-border bg-muted/20 p-2 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-xs font-medium">
                  Channels collected from <span className="font-mono">@{parsed.username}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowBotChannels((v) => !v)}
                  disabled={botChannels.size === 0}
                >
                  {showBotChannels ? "Hide" : "Show"} bot channels ({botChannels.size})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={botChannels.size === 0}
                  onClick={() => {
                    const list = Array.from(botChannels)
                      .map((c) => (c.startsWith("@") || c.startsWith("+") ? `https://t.me/${c.replace(/^@/, "")}` : `https://t.me/${c}`))
                      .join("\n");
                    copyWithToast(list, toast, `Copied ${botChannels.size} link(s)`);
                  }}
                >
                  <Copy className="mr-1 h-3.5 w-3.5" /> Copy links
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={fetchingBotChannels || accountList.length === 0}
                  onClick={async () => {
                    if (!parsed?.username) return;
                    const accId = fetchBotAccountId || selectedIds[0] || allIds[0];
                    if (!accId) return toast.error("No account selected");
                    setFetchingBotChannels(true);
                    try {
                      const res: any = await previewChatFn({
                        data: { target: `@${parsed.username}`, accountId: accId },
                      });
                      const found = new Set<string>();
                      const pushFromText = (s?: string | null) => {
                        if (!s) return;
                        const re = /(?:https?:\/\/)?t\.me\/(\+[A-Za-z0-9_-]{6,}|[A-Za-z0-9_]{4,})/gi;
                        let m: RegExpExecArray | null;
                        while ((m = re.exec(s))) found.add(m[1]);
                        const at = s.match(/@[A-Za-z0-9_]{4,}/g) ?? [];
                        for (const h of at) found.add(h.slice(1));
                      };
                      for (const m of res?.messages ?? []) {
                        pushFromText(m?.text);
                        const rows = m?.replyMarkup?.rows ?? [];
                        for (const row of rows) for (const b of row) {
                          if (b?.url) pushFromText(b.url);
                        }
                      }
                      // Skip the bot itself
                      found.delete(parsed.username);
                      const list = Array.from(found);
                      if (!list.length) toast.info("No channel links found in bot chat");
                      else {
                        addChannelsToCurrentBot(list);
                        setShowBotChannels(true);
                        toast.success(`Imported ${list.length} link(s)`);
                      }
                    } catch (e) {
                      toast.error(`Fetch failed: ${(e as Error).message}`);
                    } finally {
                      setFetchingBotChannels(false);
                    }
                  }}
                  title="Read the bot's last messages and extract channel/invite links"
                >
                  {fetchingBotChannels ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  Fetch from bot chat
                </Button>
                <Select
                  value={fetchBotAccountId || selectedIds[0] || allIds[0] || ""}
                  onValueChange={setFetchBotAccountId}
                >
                  <SelectTrigger className="h-8 w-[180px] text-xs" title="Account used to fetch bot chat">
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accountList.map((a) => (
                      <SelectItem key={a.id} value={a.id} className="text-xs">
                        {(a as any).label || (a as any).name || (a as any).phone || a.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={botChannels.size === 0}
                  onClick={() => clearCurrentBotChannels()}
                  title="Clear collected list"
                >
                  Clear
                </Button>
              </div>
              {botChannels.size === 0 && (
                <div className="text-[11px] text-muted-foreground">
                  No links collected yet for this bot. Run the flow to auto-harvest, or click
                  <span className="mx-1 font-medium">Fetch from bot chat</span>
                  to pull the latest links straight from <span className="font-mono">@{parsed.username}</span>.
                </div>
              )}
              {showBotChannels && (
                <div className="max-h-48 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-[11px]">
                  {Array.from(botChannels).map((c) => {
                    const url = c.startsWith("+")
                      ? `https://t.me/${c}`
                      : `https://t.me/${c.replace(/^@/, "")}`;
                    return (
                      <div key={c} className="flex items-center justify-between gap-2 py-0.5">
                        <a href={url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                          {url}
                        </a>
                        <button
                          onClick={() => copyWithToast(url, toast, "Copied")}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          title="Copy link"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {(running || Object.keys(joinState).length > 0 || totals) && (
            <OverallProgress
              running={running}
              startAt={runStartAt}
              nowTick={nowTick}
              accountsTotal={accountsTotal}
              accountsDone={accountsDone}
              joinState={joinState}
              totals={totals}
            />
          )}
          {Object.keys(joinState).length > 0 && (
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Auto-join progress</div>
                <div className="text-xs text-muted-foreground">
                  {Object.values(joinState).reduce((s, j) => s + j.remaining, 0)} channel(s) remaining across all accounts
                </div>
              </div>
              <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                {Object.entries(joinState).map(([id, j]) => {
                  const a = accountList.find((x) => x.id === id);
                  const who = a?.first_name || a?.username || a?.phone || id.slice(0, 8);
                  const pct = j.total ? Math.round((j.joined / j.total) * 100) : 0;
                  return (
                    <div key={id} className="rounded border border-border bg-background/60 px-2 py-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="min-w-[100px] truncate font-medium">{who}</span>
                        <span className="text-muted-foreground">
                          {j.joined}/{j.total} joined · <span className={j.remaining ? "text-yellow-600 dark:text-yellow-400" : "text-green-600 dark:text-green-400"}>{j.remaining} left</span>
                          {typeof j.round === "number" && <> · round {j.round}</>}
                        </span>
                        {j.stopped && (
                          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground" title={`Stop reason: ${j.reason}`}>
                            {j.reason ?? "stopped"}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted">
                        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      {j.remainingList.length > 0 && (
                        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={j.remainingList.join(", ")}>
                          pending: {j.remainingList.slice(0, 6).join(", ")}{j.remainingList.length > 6 ? ` +${j.remainingList.length - 6}` : ""}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {parsed?.username && (
            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                <div className="text-sm font-medium">
                  Open <span className="font-mono">@{parsed.username}</span> chat per account
                </div>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={openChats}>
                    <Play className="mr-1 h-4 w-4" /> Open chats
                  </Button>
                  {chatOpen.length > 0 && (
                    <Button size="sm" variant="outline" onClick={clearChats}>
                      Close all
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Each selected account gets its own live mini-Telegram box below — reply,
                tap inline buttons, launch mini apps, all inline (no redirect).
              </p>

              {chatOpen.length > 0 && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs">
                    <span className="text-muted-foreground">
                      Showing {visibleChatIds.length} of {chatOpen.length}
                      {queuedChatCount > 0 ? ` · ${queuedChatCount} queued` : ""}
                    </span>
                    {queuedChatCount > 0 && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setChatVisibleCount((n) => Math.min(chatOpen.length, n + 1))}
                        >
                          Open next
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="hidden md:inline-flex"
                          onClick={() => setChatVisibleCount((n) => Math.min(chatOpen.length, n + 3))}
                        >
                          Show 3 more
                        </Button>
                      </>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {visibleChatIds.map((id) => {
                    const a = accountList.find((x) => x.id === id);
                    const who = a?.first_name || a?.username || a?.phone || id.slice(0, 8);
                    const src = `/accounts/${id}?peer=${encodeURIComponent(`@${parsed.username}`)}&solo=1`;
                    return (
                      <div key={id} className="flex h-[560px] flex-col overflow-hidden rounded-md border border-border bg-background">
                        <div className="flex items-center gap-2 border-b px-2 py-1.5">
                          <div className="min-w-0 flex-1 text-xs">
                            <div className="truncate font-semibold">{who}</div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              @{parsed.username}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="rounded p-1 hover:bg-muted"
                            title="Close"
                            onClick={() => closeChat(id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <iframe
                          src={src}
                          title={`${who} — @${parsed.username}`}
                          className="h-full w-full flex-1 border-0"
                          loading="lazy"
                        />
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection storageKey="botflow.extract" title="Extract verify links (per account)" defaultOpen={false}>
          <p className="text-xs text-muted-foreground">
            Paste a bot link/username. For each selected account, the system will
            <code className="mx-1">/start</code> the bot, find the inline
            <em> Verify </em> button (or any matching label), and return that
            account's personal <code>tgWebAppData</code>-signed URL. Copy any
            link and open it wherever you want.
          </p>

          <div className="grid gap-3 md:grid-cols-[1fr_200px]">
            <div>
              <Label>Bot link or @username</Label>
              <Input
                value={vxLink}
                onChange={(e) => setVxLink(e.target.value)}
                placeholder="https://t.me/BonusCash_referbot?start=XXXX  or  @BonusCash_referbot"
              />
              {vxParsed?.username && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Bot: <span className="font-mono text-foreground">@{vxParsed.username}</span>
                  {vxParsed.startParam && (
                    <> · start: <span className="font-mono text-foreground">{vxParsed.startParam}</span></>
                  )}
                </p>
              )}
            </div>
            <div>
              <Label>Button label contains</Label>
              <Input
                value={vxButtonText}
                onChange={(e) => setVxButtonText(e.target.value)}
                placeholder="verify"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium mr-auto">
                {vxSelected.length} / {allIds.length} accounts selected
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setVxSelected(allIds)}>Select all</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setVxSelected([])}>Deselect all</Button>
            </div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-56 overflow-auto rounded-md border border-border p-2">
              {accountList.map((a) => {
                const checked = vxSelected.includes(a.id);
                return (
                  <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40">
                    <input type="checkbox" checked={checked} onChange={() => vxToggle(a.id)} />
                    <span className="truncate">{a.first_name || a.username || a.phone}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={runExtractVerify} disabled={vxRunning || !vxParsed?.username || allIds.length === 0}>
              {vxRunning ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}
              Extract links
            </Button>
            {vxResults.length > 0 && (
              <>
                <Button variant="outline" onClick={copyAllVerify}>
                  <Copy className="mr-1 h-4 w-4" /> Copy all
                </Button>
                <Button variant="ghost" onClick={() => setVxResults([])}>Clear</Button>
              </>
            )}
          </div>

          {vxResults.length > 0 && (
            <div className="space-y-1">
              {vxResults.map((r) => {
                const acc = accountList.find((a) => a.id === r.accountId);
                const who = acc?.first_name || acc?.username || acc?.phone || r.accountId.slice(0, 8);
                return (
                  <div key={r.accountId} className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-2 py-1.5 text-xs">
                    <div className="min-w-[140px] truncate font-medium">{who}</div>
                    {r.status === "loading" && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> resolving…
                      </div>
                    )}
                    {r.status === "error" && (
                      <div className="truncate text-destructive" title={r.error}>{r.error}</div>
                    )}
                    {r.status === "ready" && r.url && (
                      <>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {r.kind}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={r.url}>{r.url}</span>
                        <button
                          type="button"
                          className="rounded p-1 hover:bg-muted"
                          title="Copy URL"
                          onClick={() => copyWithToast(r.url!, toast)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <BrowserPickerButton url={r.url} compact />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>

        {/* ── Mini App launcher ─────────────────────────────────────── */}
        <CollapsibleSection storageKey="botflow.miniapp" title="Open Mini App on many accounts" defaultOpen={false}>
          <p className="text-xs text-muted-foreground">
            Paste a Telegram mini app link (e.g. <code>https://t.me/wormcupbot?startapp=R84L82W</code>).
            Each selected account gets its own live mini app window below — use them independently.
          </p>

          <div>
            <Label>Mini app link</Label>
            <Input
              value={miniLink}
              onChange={(e) => setMiniLink(e.target.value)}
              placeholder="https://t.me/somebot?startapp=YOUR_REF"
            />
            {miniParsed?.username && (
              <div className="mt-2 text-xs text-muted-foreground">
                Bot: <span className="font-mono text-foreground">@{miniParsed.username}</span>
                {miniParsed.startParam ? (
                  <>
                    {" · "}startapp:{" "}
                    <span className="font-mono text-foreground">{miniParsed.startParam}</span>
                  </>
                ) : (
                  <span className="text-yellow-600 dark:text-yellow-400"> · no startapp code</span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium mr-auto">
                {miniSelected.length} / {allIds.length} accounts selected
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setMiniSelected(allIds)}>Select all</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setMiniSelected([])}>Deselect all</Button>
            </div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-56 overflow-auto rounded-md border border-border p-2">
              {accountList.map((a) => {
                const checked = miniSelected.includes(a.id);
                return (
                  <label key={a.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40">
                    <input type="checkbox" checked={checked} onChange={() => miniToggle(a.id)} />
                    <span className="truncate">{a.first_name || a.username || a.phone}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={runMini} disabled={!miniParsed?.username || allIds.length === 0}>
              <Play className="mr-1 h-4 w-4" /> Open on selected
            </Button>
            {miniRuns.length > 0 && (
              <Button variant="outline" onClick={clearMini}>
                Close all
              </Button>
            )}
          </div>

          {miniRuns.length > 0 && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {miniRuns.map((r) => {
                const acc = accountList.find((a) => a.id === r.accountId);
                const who = acc?.first_name || acc?.username || acc?.phone || r.accountId.slice(0, 8);
                return (
                  <div key={r.accountId} className="flex h-[520px] flex-col overflow-hidden rounded-md border border-border bg-background">
                    <div className="flex items-center gap-2 border-b px-2 py-1.5">
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="truncate font-semibold">{who}</div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {r.status === "loading"
                            ? "Resolving…"
                            : r.status === "error"
                              ? "Failed"
                              : r.url
                                ? new URL(r.url).host
                                : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
                        title="Resolve and refresh this mini app"
                        disabled={r.status === "loading"}
                        onClick={() => miniParsed && resolveOne(r.accountId, miniParsed.username, miniParsed.startParam)}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${r.status === "loading" ? "animate-spin" : ""}`} />
                        Refresh
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 hover:bg-muted"
                        title="Close"
                        onClick={() => closeMini(r.accountId)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="relative flex-1">
                      {r.status === "loading" && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                      )}
                      {r.status === "error" && (
                        <div className="p-3 text-xs text-destructive">{r.error}</div>
                      )}
                       {r.status === "ready" && r.url && (
                         <MiniAppFrame url={r.url} title={who} accountId={r.accountId} botUsername={miniParsed?.username ?? ""} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          storageKey="botflow.verifyrunner"
          title="Bulk Verification Link Runner"
          defaultOpen={false}
        >
          <BulkVerifyRunner accountList={accountList} />
        </CollapsibleSection>

        <CollapsibleSection storageKey="botflow.verifysingle" title="Verification URL runner (single account)" defaultOpen={false}>
          <p className="text-xs text-muted-foreground">
            Paste a direct mini-app verification URL and open it inside a specific account's proxy.
          </p>

          <div className="grid gap-3 md:grid-cols-[1fr_260px]">
            <div>
              <Label>Verification URL</Label>
              <Input
                value={verifyLink}
                onChange={(e) => setVerifyLink(e.target.value)}
                placeholder="https://bots.princewallet.in/verify/Shadow_pointbot#tgWebAppData=..."
              />
            </div>
            <div>
              <Label>Account</Label>
              <select
                value={verifyAccountId}
                onChange={(e) => setVerifyAccountId(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select account</option>
                {accountList.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.first_name || a.username || a.phone || a.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {verifySession.hasInitData && (
            <div
              className={`rounded-md border p-3 text-xs ${
                verifyLinkAccountMismatch
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
              }`}
            >
              <div className="font-medium">
                This direct verification URL is already signed for Telegram user{" "}
                <span className="font-mono">
                  {verifySession.userLabel ? `${verifySession.userLabel} ` : ""}
                  {verifySession.userId ? `#${verifySession.userId}` : "unknown"}
                </span>
                .
              </div>
              <div className="mt-1">
                Selecting another website account will not change that signed Telegram session, so the bot can show “Same Device Detected”. For different accounts, use the original <code>t.me/...?...startapp=</code> link in “Open Mini App on many accounts”.
              </div>
              {verifyLinkAccountMismatch && (
                <div className="mt-1 font-medium">
                  Selected account ID #{verifyAccountTelegramId} does not match this verification URL.
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={openVerification} disabled={!normalizedVerifyLink || !verifyAccountId || verifyLinkAccountMismatch}>
              <Play className="mr-1 h-4 w-4" /> Open verification
            </Button>
            {verifyNonce > 0 && (
              <Button variant="outline" onClick={() => setVerifyNonce((n) => n + 1)}>
                <RefreshCw className="mr-1 h-4 w-4" /> Refresh
              </Button>
            )}
          </div>

          {verifyNonce > 0 && verifyAccountId && normalizedVerifyLink && (
            <div className="flex h-[680px] flex-col overflow-hidden rounded-md border border-border bg-background">
              <div className="flex items-center gap-2 border-b px-2 py-1.5">
                <div className="min-w-0 flex-1 text-xs">
                  <div className="truncate font-semibold">
                    {accountList.find((a) => a.id === verifyAccountId)?.first_name ||
                      accountList.find((a) => a.id === verifyAccountId)?.username ||
                      accountList.find((a) => a.id === verifyAccountId)?.phone ||
                      verifyAccountId.slice(0, 8)}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {new URL(normalizedVerifyLink).host}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded p-1 hover:bg-muted"
                  title="Close"
                  onClick={() => setVerifyNonce(0)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <VerifyFrame
                key={`${verifyAccountId}-${verifyNonce}`}
                url={normalizedVerifyLink}
                accountId={verifyAccountId}
              />
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection storageKey="botflow.logs" title="Live logs">
          <LiveLogsPanel logs={logs} accountList={accountList} onClear={() => setLogs([])} />
        </CollapsibleSection>
      </div>
    </main>
  );
}

function LiveLogsPanel({
  logs,
  accountList,
  onClear,
}: {
  logs: LogEntry[];
  accountList: Array<{ id: string; first_name?: string | null; username?: string | null; phone?: string | null }>;
  onClear: () => void;
}) {
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem("botflow.logs.hidden") === "1"; } catch { return false; }
  });
  const toggle = () => {
    setHidden((v) => {
      const nv = !v;
      try { localStorage.setItem("botflow.logs.hidden", nv ? "1" : "0"); } catch {}
      return nv;
    });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={toggle}>{hidden ? "Show" : "Hide"}</Button>
        <Button size="sm" variant="outline" onClick={onClear} disabled={logs.length === 0}>Clear</Button>
      </div>
      {!hidden && (
        <VirtualList<LogEntry>
          items={logs}
          estimateSize={20}
          className="h-96 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs"
          emptyState={<div className="text-muted-foreground">No activity yet</div>}
          getKey={(_l, i) => i}
          renderItem={(l) => {
            const acc = accountList.find((a) => a.id === l.accountId);
            const who = acc ? acc.first_name || acc.username || acc.phone : l.accountId ? l.accountId.slice(0, 8) : "—";
            const color =
              l.level === "error"
                ? "text-destructive"
                : l.level === "success"
                  ? "text-green-500"
                  : l.level === "warn"
                    ? "text-yellow-500"
                    : "text-foreground";
            return (
              <div className={color}>
                [{new Date(l.ts).toLocaleTimeString()}] {who}{l.target ? ` · ${l.target}` : ""} — {l.message}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

function MiniAppFrame({ url, title, accountId, botUsername }: { url: string; title: string; accountId: string; botUsername: string }) {
  return <MiniAppFrameImpl url={url} title={title} accountId={accountId} botUsername={botUsername} />;
}

function BotFlowCaptchaCard() {
  const [cfg, set] = useBotFlowCaptchaConfig();
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-semibold">Captcha auto-solve</h2>
          <p className="text-xs text-muted-foreground">
            When enabled, captchas that appear in bot replies or mini-apps are auto-solved with the
            chosen type &amp; provider. Manage keys on the{" "}
            <Link to="/captcha" className="underline text-primary">Captcha Solver</Link> page.
          </p>
        </div>
        <Switch checked={cfg.enabled} onCheckedChange={(v) => set({ enabled: v })} />
      </div>
      {cfg.enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Captcha type</Label>
            <Select value={cfg.kind} onValueChange={(v) => set({ kind: v as never })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {CAPTCHA_KIND_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Preferred provider</Label>
            <Select value={cfg.provider} onValueChange={(v) => set({ provider: v as never })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CAPTCHA_PROVIDER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </section>
  );
}

function VerifyFrame({ url, accountId }: { url: string; accountId: string }) {
  const { url: proxied } = useMiniAppProxyUrl(url, accountId);
  return (
    <iframe
      src={proxied ?? "about:blank"}
      title="Verification runner"
      className="h-full w-full flex-1 border-0"
      allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-storage-access-by-user-activation"
      referrerPolicy="no-referrer"
    />
  );
}

// ─── Bulk verification link runner ──────────────────────────────────
// Paste many verification URLs, assign an account per link (round-robin
// by default) and open them all at once. Each iframe gets a unique
// fingerprint seed so the derived UA / screen / timezone / canvas / TZ
// differ per run — even for the same account. If the server has
// MINIAPP_PROXY_URL_TEMPLATE set, each upstream fetch also rotates its
// outbound IP via the configured proxy service.
type BulkRowStatus = "queued" | "running" | "success" | "failed" | "manual";
type BulkRowLog = { ts: number; level: "info" | "warn" | "error" | "success"; msg: string };
type BulkRow = {
  id: string;
  url: string;
  accountId: string;
  fpSeed: string;
  status: BulkRowStatus;
  logs: BulkRowLog[];
};

function BulkVerifyRunner({
  accountList,
}: {
  accountList: Array<{ id: string; first_name?: string | null; username?: string | null; phone?: string | null }>;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [runNonce, setRunNonce] = useState(0);
  const [openLogs, setOpenLogs] = useState<Record<string, boolean>>({});
  const [stableDevice, setStableDevice] = useState(true);
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});

  // Stable fingerprint per account: same seed every run for the same account,
  // so the target site sees a consistent device instead of a brand-new one.
  const stableSeedFor = (accountId: string) => `acc-${accountId}`;

  // Patterns that indicate the site refused the request because of device /
  // account fingerprint checks — do not fake success, mark for manual review.
  const MANUAL_PATTERNS = [
    /same device/i,
    /device.*(blocked|banned|not allowed|already)/i,
    /already (verified|claimed|used)/i,
    /multi(ple)?[- ]?accounts?/i,
    /suspicious/i,
    /fraud/i,
    /vpn|proxy detected/i,
  ];

  const appendLog = useCallback((id: string, entry: BulkRowLog, statusPatch?: BulkRowStatus) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              status: statusPatch ?? r.status,
              logs: [...r.logs.slice(-199), entry],
            }
          : r,
      ),
    );
  }, []);

  useEffect(() => {
    const findIdBySource = (src: unknown): string | null => {
      for (const [id, el] of Object.entries(iframeRefs.current)) {
        if (el && el.contentWindow === src) return id;
      }
      return null;
    };
    const onMsg = (ev: MessageEvent) => {
      const id = findIdBySource(ev.source);
      if (!id) return;
      let payload: any = ev.data;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { return; }
      }
      if (!payload || typeof payload !== "object") return;
      const { eventType, eventData } = payload as { eventType?: string; eventData?: any };
      if (!eventType) return;
      const now = Date.now();
      if (eventType === "captcha_log") {
        const level = (eventData?.level as BulkRowLog["level"]) || "info";
        const msg = String(eventData?.msg || "");
        let status: BulkRowStatus | undefined;
        if (MANUAL_PATTERNS.some((re) => re.test(msg))) status = "manual";
        else if (/callback fired with token/i.test(msg)) status = "success";
        else if (level === "error") status = "failed";
        appendLog(id, { ts: now, level, msg }, status);
      } else if (eventType === "captcha_detected") {
        const n = Array.isArray(eventData?.items) ? eventData.items.length : 0;
        appendLog(id, { ts: now, level: "info", msg: `captcha detected (${n})` });
      } else if (eventType === "web_app_close") {
        appendLog(id, { ts: now, level: "success", msg: "mini-app closed (likely verified)" }, "success");
      } else if (eventType === "web_app_open_tg_link") {
        appendLog(id, { ts: now, level: "info", msg: `open tg link: ${eventData?.url || ""}` });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [appendLog]);

  const parsedLinks = useMemo(() => {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (/^https?:\/\//i.test(l) ? l : `https://${l}`))
      .filter((l) => {
        try { new URL(l); return true; } catch { return false; }
      });
  }, [text]);

  const toggleAcc = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectAll = () => setSelected(accountList.map((a) => a.id));
  const selectNone = () => setSelected([]);

  const buildRows = () => {
    if (!parsedLinks.length) return toast.error("Paste at least one verification link");
    const accs = selected.length ? selected : accountList.map((a) => a.id);
    if (!accs.length) return toast.error("Select at least one account");
    const salt = Date.now().toString(36);
    const built: BulkRow[] = parsedLinks.map((url, i) => ({
      id: `${salt}-${i}`,
      url,
      accountId: accs[i % accs.length],
      // Stable per-account seed by default → same device is presented every
      // time for that account. Turn off "Stable device" to use a fresh one.
      fpSeed: stableDevice
        ? stableSeedFor(accs[i % accs.length])
        : `${salt}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      status: "queued" as BulkRowStatus,
      logs: [] as BulkRowLog[],
    }));
    setRows(built);
    setRunNonce((n) => n + 1);
  };

  const rerollAll = () => {
    const salt = Date.now().toString(36);
    setRows((prev) =>
      prev.map((r, i) => ({
        ...r,
        fpSeed: stableDevice
          ? stableSeedFor(r.accountId)
          : `${salt}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        status: "queued",
        logs: [],
      })),
    );
    setRunNonce((n) => n + 1);
  };

  const rerollOne = (id: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, fpSeed: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` } : r,
      ),
    );
  };

  const removeOne = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id));
  const clearAll = () => setRows([]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Paste many verification URLs (one per line). Each is opened in its own iframe with a unique
        device fingerprint (UA, screen, timezone, canvas, languages). Accounts are round-robin
        assigned from your selection. Use “Reroll” to force fresh fingerprints on the next run.
        Outbound IP rotation is applied automatically when the server proxy template is configured
        (secret <code>MINIAPP_PROXY_URL_TEMPLATE</code>).
      </p>

      <label className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={stableDevice}
          onChange={(e) => setStableDevice(e.target.checked)}
        />
        <span>
          <span className="font-medium">Stable device per account</span>{" "}
          <span className="text-muted-foreground">
            (recommended) — reuse the same fingerprint for each account across runs instead of a fresh one.
            Sites that block repeat / same-device attempts are flagged as <em>manual</em> instead of faked as success.
          </span>
        </span>
      </label>

      <div className="grid gap-3 md:grid-cols-[1fr_260px]">
        <div>
          <Label>Verification URLs (one per line)</Label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            className="mt-1 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
            placeholder={"https://bots.example.com/verify/xyz#tgWebAppData=...\nhttps://bots.example.com/verify/abc#tgWebAppData=..."}
          />
          <div className="mt-1 text-[11px] text-muted-foreground">
            {parsedLinks.length} valid link(s) parsed.
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label>Accounts (round-robin)</Label>
            <div className="flex gap-1">
              <button type="button" className="text-[11px] underline" onClick={selectAll}>All</button>
              <button type="button" className="text-[11px] underline" onClick={selectNone}>None</button>
            </div>
          </div>
          <div className="mt-1 max-h-40 space-y-1 overflow-auto rounded border border-input p-2">
            {accountList.length === 0 && (
              <div className="text-[11px] text-muted-foreground">No accounts</div>
            )}
            {accountList.map((a) => {
              const label = a.first_name || a.username || a.phone || a.id.slice(0, 8);
              return (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.includes(a.id)}
                    onChange={() => toggleAcc(a.id)}
                  />
                  <span className="truncate">{label}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {selected.length || accountList.length} account(s) will rotate
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={buildRows} disabled={parsedLinks.length === 0}>
          <Play className="mr-1 h-4 w-4" /> Run all
        </Button>
        {rows.length > 0 && (
          <>
            <Button variant="outline" onClick={rerollAll}>
              <RefreshCw className="mr-1 h-4 w-4" /> Reroll fingerprints
            </Button>
            <Button variant="outline" onClick={clearAll}>
              <X className="mr-1 h-4 w-4" /> Close all
            </Button>
          </>
        )}
      </div>

      {rows.length > 0 && (
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold">Progress</div>
            <div className="flex gap-2 text-[11px] text-muted-foreground">
              {(["queued", "running", "success", "failed"] as BulkRowStatus[]).map((s) => {
                const n = rows.filter((r) => r.status === s).length;
                return (
                  <span key={s} className="capitalize">
                    {s}: <span className="font-mono text-foreground">{n}</span>
                  </span>
                );
              })}
              <span>
                manual: <span className="font-mono text-yellow-600 dark:text-yellow-400">
                  {rows.filter((r) => r.status === "manual").length}
                </span>
              </span>
              <span>total: <span className="font-mono text-foreground">{rows.length}</span></span>
            </div>
          </div>
          <div className="max-h-64 space-y-1 overflow-auto">
            {rows.map((r) => {
              const acc = accountList.find((a) => a.id === r.accountId);
              const who = acc?.first_name || acc?.username || acc?.phone || r.accountId.slice(0, 8);
              let host = r.url;
              try { host = new URL(r.url).host; } catch {}
              const isOpen = !!openLogs[r.id];
              const color =
                r.status === "success" ? "bg-green-500/15 text-green-600 dark:text-green-400"
                : r.status === "failed" ? "bg-destructive/15 text-destructive"
                : r.status === "manual" ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400"
                : r.status === "running" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                : "bg-muted text-muted-foreground";
              return (
                <div key={r.id} className="rounded border border-border bg-background">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                    onClick={() => setOpenLogs((o) => ({ ...o, [r.id]: !o[r.id] }))}
                  >
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>
                      {r.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{who}</span>
                      <span className="text-muted-foreground"> · {host}</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">{r.logs.length} log(s)</span>
                    <span className="text-[10px] text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <div className="max-h-40 overflow-auto border-t bg-muted/20 p-2 font-mono text-[10px]">
                      {r.logs.length === 0 ? (
                        <div className="text-muted-foreground">No events yet.</div>
                      ) : (
                        r.logs.map((l, i) => (
                          <div
                            key={i}
                            className={
                              l.level === "error" ? "text-destructive"
                              : l.level === "warn" ? "text-yellow-600 dark:text-yellow-400"
                              : l.level === "success" ? "text-green-600 dark:text-green-400"
                              : "text-foreground"
                            }
                          >
                            <span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()} </span>
                            [{l.level}] {l.msg}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => {
            const acc = accountList.find((a) => a.id === r.accountId);
            const who = acc?.first_name || acc?.username || acc?.phone || r.accountId.slice(0, 8);
            let host = r.url;
            try { host = new URL(r.url).host; } catch {}
            return (
              <div key={r.id} className="flex h-[520px] flex-col overflow-hidden rounded-md border border-border bg-background">
                <div className="flex items-center gap-2 border-b px-2 py-1.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{who}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {host} · fp:{r.fpSeed.slice(0, 10)}
                    </div>
                  </div>
                  <button
                    type="button"
                    title="Reroll fingerprint (fresh device)"
                    className="rounded p-1 hover:bg-muted"
                    onClick={() => rerollOne(r.id)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Close"
                    className="rounded p-1 hover:bg-muted"
                    onClick={() => removeOne(r.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <BulkVerifyFrame
                  key={`${r.id}:${r.fpSeed}:${runNonce}`}
                  url={r.url}
                  accountId={r.accountId}
                  fpSeed={r.fpSeed}
                  iframeRef={(el) => { iframeRefs.current[r.id] = el; }}
                  onLoaded={() =>
                    appendLog(r.id, { ts: Date.now(), level: "info", msg: "iframe loaded" }, "running")
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OverallProgress({
  running,
  startAt,
  nowTick,
  accountsTotal,
  accountsDone,
  joinState,
  totals,
}: {
  running: boolean;
  startAt: number | null;
  nowTick: number;
  accountsTotal: number;
  accountsDone: number;
  joinState: Record<string, { total: number; joined: number; remaining: number; stopped?: boolean }>;
  totals: { ok: number; fail: number } | null;
}) {
  const entries = Object.values(joinState);
  const total = entries.reduce((s, j) => s + (j.total || 0), 0);
  const joined = entries.reduce((s, j) => s + (j.joined || 0), 0);
  const remaining = entries.reduce((s, j) => s + (j.remaining || 0), 0);
  const running_ = entries.filter((j) => !j.stopped && j.remaining > 0).length;
  const elapsed = startAt ? Math.max(1, nowTick - startAt) : 0;
  const rate = joined > 0 && elapsed > 0 ? joined / (elapsed / 1000) : 0;
  const etaSec = rate > 0 && remaining > 0 ? Math.round(remaining / rate) : null;
  const pct = total > 0 ? Math.round((joined / total) * 100) : accountsTotal > 0 ? Math.round((accountsDone / accountsTotal) * 100) : 0;
  const fmt = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <div className="text-sm font-medium">Overall progress</div>
        <span className="text-muted-foreground">Accounts <span className="text-foreground">{accountsDone}/{accountsTotal}</span></span>
        <span className="text-muted-foreground">Running <span className="text-blue-600 dark:text-blue-400">{running_}</span></span>
        <span className="text-muted-foreground">Joined <span className="text-green-600 dark:text-green-400">{joined}</span>/{total}</span>
        <span className="text-muted-foreground">Remaining <span className={remaining ? "text-yellow-600 dark:text-yellow-400" : "text-foreground"}>{remaining}</span></span>
        {totals && <span className="text-muted-foreground">ok <span className="text-green-600 dark:text-green-400">{totals.ok}</span> · fail <span className="text-destructive">{totals.fail}</span></span>}
        <span className="ml-auto text-muted-foreground">
          {startAt && <>Elapsed <span className="text-foreground">{fmt(Math.floor(elapsed / 1000))}</span></>}
          {running && etaSec != null && <> · ETA <span className="text-foreground">{fmt(etaSec)}</span></>}
          {rate > 0 && <> · {rate.toFixed(2)}/s</>}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BulkVerifyFrame({
  url,
  accountId,
  fpSeed,
  iframeRef,
  onLoaded,
}: {
  url: string;
  accountId: string;
  fpSeed: string;
  iframeRef?: (el: HTMLIFrameElement | null) => void;
  onLoaded?: () => void;
}) {
  const { url: proxied } = useMiniAppProxyUrl(url, accountId, { fpSeed });
  return (
    <iframe
      ref={iframeRef}
      src={proxied ?? "about:blank"}
      title="Bulk verification runner"
      className="h-full w-full flex-1 border-0"
      allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-storage-access-by-user-activation"
      referrerPolicy="no-referrer"
      onLoad={onLoaded}
    />
  );
}

function MiniAppFrameImpl({ url, title, accountId, botUsername }: { url: string; title: string; accountId: string; botUsername: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const joinFn = useServerFn(joinFromLink);
  const { url: proxiedUrl } = useMiniAppProxyUrl(url, accountId);
  const [nonce, setNonce] = useState(0);
  const [overlay, setOverlay] = useState<
    | { status: "loading"; url: string }
    | { status: "ready"; url: string; peerKey: string; title: string; note: string }
    | { status: "error"; url: string; error: string }
    | null
  >(null);
  useTelegramWebviewBridge(ref, {
    onClose: () => {
      if (!botUsername) return false;
      setOverlay({
        status: "ready",
        url,
        peerKey: `@${botUsername.replace(/^@/, "")}`,
        title: `@${botUsername.replace(/^@/, "")}`,
        note: "Bot chat",
      });
      return true;
    },
    onOpenTgLink: (link) => {
      // Intercept: resolve+join via THIS account, then show chat in same tile.
      setOverlay({ status: "loading", url: link });
      joinFn({ data: { accountId, url: link } })
        .then((res) => {
          setOverlay({
            status: "ready",
            url: link,
            peerKey: res.peerKey,
            title: res.title,
            note: res.joined
              ? "Joined ✓"
              : res.alreadyMember
                ? "Already a member"
                : "Opened",
          });
        })
        .catch((e: Error) =>
          setOverlay({ status: "error", url: link, error: e.message || "Failed" }),
        );
      return true; // handled
    },
  });
  return (
    <div className="relative h-full w-full">
      <iframe
        key={`${url}#${nonce}`}
        ref={ref}
        src={proxiedUrl ?? "about:blank"}
        title={title}
        name={`tgminiapp-${accountId}`}
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-storage-access-by-user-activation"
        referrerPolicy="no-referrer"
      />
      {overlay && (
        <div className="absolute inset-0 flex flex-col bg-background">
          <div className="flex items-center gap-2 border-b px-2 py-1.5 text-xs">
            <button
              type="button"
              className="rounded p-1 hover:bg-muted"
              onClick={() => setOverlay(null)}
              title="Back to mini app"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">
                {overlay.status === "ready" ? overlay.title : "Opening…"}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {overlay.status === "ready" ? overlay.note : overlay.url}
              </div>
            </div>
          </div>
          <div className="relative flex-1">
            {overlay.status === "loading" && (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {overlay.status === "error" && (
              <div className="p-3 text-xs text-destructive">{overlay.error}</div>
            )}
            {overlay.status === "ready" && (
              <iframe
                key={overlay.peerKey}
                src={`/accounts/${accountId}?peer=${encodeURIComponent(overlay.peerKey)}&solo=1`}
                title={overlay.title}
                className="h-full w-full border-0"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}