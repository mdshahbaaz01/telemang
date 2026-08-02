import { createFileRoute, Link } from "@tanstack/react-router";
import { AccountRangeControls, pickRange } from "@/components/AccountRangeControls";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTelegramWebviewBridge } from "@/lib/telegram-webview-bridge";
import { MiniAppChrome } from "@/components/MiniAppChrome";
import { supabase } from "@/integrations/supabase/client";
import { listAccounts } from "@/lib/accounts.functions";
import {
  openStartAppLink,
  joinFromLink,
  extractVerifyLink,
  pressInlineButtonAs,
  sendMessageAs,
} from "@/lib/tg-viewer.functions";
import { sendMediaAs } from "@/lib/tg-viewer.functions";
import { listMedia } from "@/lib/media-library.functions";
import { previewChat } from "@/lib/chat-viewer.functions";
import { useMiniAppProxyUrl } from "@/lib/miniapp-proxy-url";
import { AdminGate } from "@/components/AdminGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Play, Square, ArrowLeft, Loader2, RefreshCw, X, MessageSquare, Copy, ExternalLink, UserPlus } from "lucide-react";
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
          concurrency: runParallel ? Math.max(1, Math.min(20, accountIds.length)) : 1,
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
  // Concurrency cap for mounted mini-app iframes. Each iframe boots a full
  // Telegram WebView proxy + fingerprint bridge; mounting 10+ at once
  // exhausts browser/network resources and produces black screens.
  const [miniLimit, setMiniLimit] = useState<number>(() => {
    if (typeof window === "undefined") return 3;
    try {
      const s = window.localStorage.getItem("botflow.miniLimit");
      if (s) return Math.max(1, Math.min(12, parseInt(s, 10) || 3));
    } catch {}
    return 3;
  });
  useEffect(() => {
    try { window.localStorage.setItem("botflow.miniLimit", String(miniLimit)); } catch {}
  }, [miniLimit]);
  const [miniMounted, setMiniMounted] = useState<Set<string>>(new Set());
  const toggleMiniMount = (id: string) =>
    setMiniMounted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Auto-mount ready panels up to the concurrency cap, in list order.
  useEffect(() => {
    setMiniMounted((prev) => {
      const ready = miniRuns.filter((r) => r.status === "ready" && r.url);
      const kept = new Set<string>();
      for (const r of ready) if (prev.has(r.accountId)) kept.add(r.accountId);
      for (const r of ready) {
        if (kept.size >= miniLimit) break;
        kept.add(r.accountId);
      }
      // no-op if identical
      if (kept.size === prev.size && [...kept].every((x) => prev.has(x))) return prev;
      return kept;
    });
  }, [miniRuns, miniLimit]);

  const miniParsed = useMemo(() => {
    const raw = miniLink.trim();
    if (!raw) return null;
    // Bare bot handle ("@somebot" / "somebot") — open that bot's main mini app.
    if (/^@?[A-Za-z0-9_]{3,64}$/.test(raw)) {
      return { username: raw.replace(/^@/, ""), startParam: "", appShortName: "" };
    }
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

  // Launch a mini app straight from any bot chat (Run-a-bot section).
  const [miniOpenSignal, setMiniOpenSignal] = useState(0);
  const [botChatMini, setBotChatMini] = useState("");
  const openMiniFromBot = async (rawBot: string, startParam: string, ids: string[]) => {
    const username = rawBot
      .trim()
      .replace(/^https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i, "")
      .replace(/^@/, "")
      .split(/[/?]/)[0];
    if (!username) return toast.error("Enter a bot @username or t.me link");
    if (!ids.length) return toast.error("Select at least one account");
    setMiniLink(startParam ? `https://t.me/${username}?startapp=${startParam}` : `@${username}`);
    setMiniSelected(ids);
    setMiniOpenSignal((n) => n + 1);
    setMiniRuns(ids.map((id) => ({ accountId: id, status: "loading" as const })));
    await Promise.all(ids.map((id) => resolveOne(id, username, startParam)));
  };

  // ─── Verify-link extractor ───────────────────────────────────────
  const [vxLink, setVxLink] = useState("");
  const [vxButtonText, setVxButtonText] = useState("verify");
  const [vxSelected, setVxSelected] = useState<string[]>([]);
  const [vxRunning, setVxRunning] = useState(false);
  // Optional: auto-send each extracted link to a target chat from the SAME account
  const [vxAutoSend, setVxAutoSend] = useState(false);
  const [vxTarget, setVxTarget] = useState("");
  const [vxTemplate, setVxTemplate] = useState("{link}");
  useEffect(() => {
    try {
      const raw = localStorage.getItem("botflow.vxAutoSend");
      if (raw) {
        const p = JSON.parse(raw) as { on?: boolean; target?: string; tpl?: string };
        setVxAutoSend(!!p.on);
        setVxTarget(p.target ?? "");
        setVxTemplate(p.tpl || "{link}");
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "botflow.vxAutoSend",
        JSON.stringify({ on: vxAutoSend, target: vxTarget, tpl: vxTemplate }),
      );
    } catch { /* ignore */ }
  }, [vxAutoSend, vxTarget, vxTemplate]);
  const [vxResults, setVxResults] = useState<
    { accountId: string; status: "loading" | "ready" | "error"; url?: string; label?: string; kind?: "webview" | "url"; error?: string; sent?: "ok" | "fail"; sendError?: string }[]
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

  // "@name" | "t.me/name" | "c:123" → peer key accepted by sendMessageAs
  const normalizeVxTarget = (raw: string) => {
    const t = raw.trim();
    if (!t) return "";
    if (/^[ucg]:\d+$/.test(t)) return t;
    const cleaned = t
      .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, "")
      .replace(/^@/, "")
      .split(/[/?]/)[0];
    return cleaned ? `@${cleaned}` : "";
  };
  const vxTargetKey = useMemo(() => normalizeVxTarget(vxTarget), [vxTarget]);

  const runExtractVerify = async () => {
    if (!vxParsed?.username) return toast.error("Paste a bot link or @username");
    const ids = vxSelected.length ? vxSelected : allIds;
    if (!ids.length) return toast.error("Select at least one account");
    if (vxAutoSend && !vxTargetKey) return toast.error("Enter a target chat for auto-send");
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
          if (vxAutoSend && vxTargetKey && res.url) {
            try {
              const text = (vxTemplate || "{link}").includes("{link}")
                ? (vxTemplate || "{link}").replace(/\{link\}/g, res.url)
                : `${vxTemplate} ${res.url}`.trim();
              await sendMessageAs({
                data: { accountId, peerKey: vxTargetKey, text },
              });
              setVxResults((prev) =>
                prev.map((r) => (r.accountId === accountId ? { ...r, sent: "ok" } : r)),
              );
            } catch (e) {
              setVxResults((prev) =>
                prev.map((r) =>
                  r.accountId === accountId
                    ? { ...r, sent: "fail", sendError: (e as Error).message || "Send failed" }
                    : r,
                ),
              );
            }
          }
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

  // Auto-select the matching website account when the verification link is
  // already signed for a specific Telegram user id.
  useEffect(() => {
    if (!verifySession.userId) return;
    if (selectedVerifyAccount && String(selectedVerifyAccount.telegram_user_id ?? "") === verifySession.userId) return;
    const match = accountList.find(
      (a) => a.telegram_user_id != null && String(a.telegram_user_id) === verifySession.userId,
    );
    if (match && match.id !== verifyAccountId) {
      setVerifyAccountId(match.id);
    }
  }, [verifySession.userId, accountList, selectedVerifyAccount, verifyAccountId]);

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
  // Cap concurrent iframes to avoid 30+ parallel Telegram client boots
  // (each iframe loads the full app and opens its own MTProto session).
  const CHAT_BATCH_DESKTOP = 4;
  const CHAT_BATCH_MOBILE = 1;
  const openChats = () => {
    if (!parsed?.username) return toast.error("Paste a bot referral link first");
    const ids = selectedIds.length ? selectedIds : allIds;
    if (!ids.length) return toast.error("Select at least one account");
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    const batch = isMobile ? CHAT_BATCH_MOBILE : CHAT_BATCH_DESKTOP;
    setChatVisibleCount(Math.min(ids.length, batch));
    setChatOpen(ids);
  };
  const closeChat = (id: string) => {
    setChatOpen((prev) => {
      const next = prev.filter((x) => x !== id);
      // Keep the batch size steady so a queued account slides into the freed slot.
      return next;
    });
  };
  const clearChats = () => {
    setChatOpen([]);
    setChatVisibleCount(1);
  };
  const visibleChatIds = chatOpen.slice(0, chatVisibleCount);
  const queuedChatCount = Math.max(0, chatOpen.length - visibleChatIds.length);
  // Per-account reload nonces so a single "Re-run" only restarts that iframe.
  const [chatReload, setChatReload] = useState<Record<string, number>>({});
  const rerunChat = (id: string) =>
    setChatReload((p) => ({ ...p, [id]: (p[id] ?? 0) + 1 }));

  // ─── Broadcast bot button to all open chats ───────────────────────
  const pressInlineButtonAsFn = useServerFn(pressInlineButtonAs);
  const sendMessageAsFn = useServerFn(sendMessageAs);
  type BroadcastBtn = { label: string; kind: string; data?: string; url?: string };
  type PerAccountBtn = { peerKey: string; msgId: number; buttons: BroadcastBtn[] };
  const [botBtnState, setBotBtnState] = useState<{
    loading: boolean;
    labels: Array<{ label: string; kinds: string[] }>;
    perAccount: Record<string, PerAccountBtn>;
  }>({ loading: false, labels: [], perAccount: {} });
  const [pressingLabel, setPressingLabel] = useState<string | null>(null);
  // 0 = latest bot message with buttons, 1 = previous, 2 = older, ...
  const [botBtnOffset, setBotBtnOffset] = useState(0);

  const refreshBotButtons = useCallback(async (offsetArg?: number) => {
    const offset = Math.max(0, offsetArg ?? botBtnOffset);
    if (!parsed?.username) return {} as Record<string, PerAccountBtn>;
    if (chatOpen.length === 0) return {} as Record<string, PerAccountBtn>;
    const target = `@${parsed.username}`;
    setBotBtnState((s) => ({ ...s, loading: true }));
    const results = await Promise.all(
      chatOpen.map(async (accountId): Promise<[string, PerAccountBtn | null]> => {
        try {
          const res: any = await previewChatFn({ data: { target, accountId } });
          const peerKey: string | null = res?.peerKey ?? null;
          const messages: any[] = Array.isArray(res?.messages) ? res.messages : [];
          if (!peerKey) return [accountId, null];
          const withBtnList = [...messages].reverse().filter(
            (m: any) =>
              m.replyMarkup &&
              (m.replyMarkup.kind === "inline" || m.replyMarkup.kind === "keyboard") &&
              Array.isArray(m.replyMarkup.rows) &&
              m.replyMarkup.rows.some((r: any[]) => (r?.length ?? 0) > 0),
          );
          const withBtn = withBtnList[Math.min(offset, withBtnList.length - 1)];
          if (!withBtn) return [accountId, null];
          const buttons: BroadcastBtn[] = [];
          for (const row of withBtn.replyMarkup.rows as any[][]) {
            for (const b of row) {
              buttons.push({
                label: String(b?.text ?? ""),
                kind: String(b?.kind ?? ""),
                data: b?.data,
                url: b?.url,
              });
            }
          }
          return [accountId, { peerKey, msgId: Number(withBtn.id), buttons }];
        } catch {
          return [accountId, null];
        }
      }),
    );
    const perAccount: Record<string, PerAccountBtn> = {};
    const labelMap = new Map<string, Set<string>>();
    for (const [id, v] of results) {
      if (!v) continue;
      perAccount[id] = v;
      for (const b of v.buttons) {
        if (!labelMap.has(b.label)) labelMap.set(b.label, new Set());
        labelMap.get(b.label)!.add(b.kind);
      }
    }
    const labels = Array.from(labelMap.entries()).map(([label, kinds]) => ({
      label,
      kinds: [...kinds],
    }));
    setBotBtnState({ loading: false, labels, perAccount });
    if (!labels.length)
      toast.info(
        offset > 0
          ? `No buttons on message #${offset + 1} back — try a different offset`
          : "No inline buttons found on the bot's latest messages",
      );
    return perAccount;
  }, [chatOpen, parsed?.username, previewChatFn, botBtnOffset]);

  const broadcastPress = useCallback(
    async (label: string) => {
      const entries = Object.entries(botBtnState.perAccount);
      if (!entries.length) return toast.error("Refresh bot buttons first");
      // Mini app / URL buttons: launch the mini app for every account that has it.
      const btnsForLabel = entries
        .map(([accountId, v]) => ({ accountId, btn: v.buttons.find((b) => b.label === label) }))
        .filter((x) => !!x.btn) as { accountId: string; btn: BroadcastBtn }[];
      const isMini = btnsForLabel.some(
        (x) => x.btn.kind === "webapp" || (x.btn.kind === "url" && !!x.btn.url),
      );
      const anyCallback = btnsForLabel.some((x) => x.btn.kind === "callback" || x.btn.kind === "reply");
      if (isMini && !anyCallback) {
        const withUrl = btnsForLabel.find((x) => x.btn.url);
        const raw = withUrl?.btn.url ?? "";
        let username = parsed?.username ?? "";
        let startParam = "";
        try {
          const u = new URL(raw);
          if (/(^|\.)(t\.me|telegram\.me|telegram\.dog)$/i.test(u.hostname)) {
            username = u.pathname.split("/").filter(Boolean)[0] ?? username;
            startParam =
              u.searchParams.get("startapp") || u.searchParams.get("start") || "";
          }
        } catch { /* not an absolute t.me link — fall back to the bot itself */ }
        if (!username) return toast.error("Could not resolve the mini app from this button");
        return openMiniFromBot(username, startParam, btnsForLabel.map((x) => x.accountId));
      }
      setPressingLabel(label);
      let ok = 0, fail = 0, skip = 0;
      await Promise.all(
        entries.map(async ([accountId, v]) => {
          const btn = v.buttons.find((b) => b.label === label);
          if (!btn) { skip++; return; }
          try {
            if (btn.kind === "callback" && btn.data) {
              await pressInlineButtonAsFn({
                data: { accountId, peerKey: v.peerKey, msgId: v.msgId, data: btn.data, buttonLabel: label },
              });
              ok++;
            } else if (btn.kind === "reply") {
              await sendMessageAsFn({
                data: { accountId, peerKey: v.peerKey, text: label },
              });
              ok++;
            } else {
              skip++;
            }
          } catch {
            fail++;
          }
        }),
      );
      setPressingLabel(null);
      toast.success(`"${label}" → ok:${ok} fail:${fail} skip:${skip}`);
    },
    [botBtnState.perAccount, pressInlineButtonAsFn, sendMessageAsFn],
  );

  // ─── Broadcast a typed message to every open chat ─────────────────
  const [broadcastText, setBroadcastText] = useState("");
  const [broadcastingMsg, setBroadcastingMsg] = useState(false);
  // Live refs to each open chat iframe so we can nudge them to refetch
  // history without reloading (which would restart the session).
  const chatFrames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const pingOpenChats = useCallback(() => {
    for (const el of Object.values(chatFrames.current)) {
      try {
        el?.contentWindow?.postMessage({ type: "tg-refresh-history" }, window.location.origin);
      } catch {}
    }
  }, []);
  const broadcastMessage = useCallback(async () => {
    const text = broadcastText.trim();
    if (!text) return;
    if (!parsed?.username) return toast.error("Open a bot chat first");
    if (chatOpen.length === 0) return toast.error("No open accounts");
    const target = `@${parsed.username}`;
    setBroadcastingMsg(true);
    let ok = 0, fail = 0;
    await Promise.all(
      chatOpen.map(async (accountId) => {
        try {
          let peerKey = botBtnState.perAccount[accountId]?.peerKey ?? null;
          if (!peerKey) {
            const res: any = await previewChatFn({ data: { target, accountId } });
            peerKey = res?.peerKey ?? null;
          }
          if (!peerKey) { fail++; return; }
          await sendMessageAsFn({ data: { accountId, peerKey, text } });
          ok++;
        } catch {
          fail++;
        }
      }),
    );
    setBroadcastingMsg(false);
    if (ok) setBroadcastText("");
    toast[fail && !ok ? "error" : "success"](`Message sent → ok:${ok} fail:${fail}`);
    // Keep sessions alive: ask each open chat frame to pull new history
    // instead of remounting/reloading the iframe.
    pingOpenChats();
    setTimeout(pingOpenChats, 1500);
    setTimeout(pingOpenChats, 4000);
  }, [broadcastText, parsed?.username, chatOpen, botBtnState.perAccount, previewChatFn, sendMessageAsFn]);

  // Resolve (and memoize) the bot peerKey for one account.
  const peerKeyCache = useRef<Record<string, string>>({});
  const resolvePeerKeyFor = useCallback(
    async (accountId: string): Promise<string | null> => {
      const cached = botBtnState.perAccount[accountId]?.peerKey ?? peerKeyCache.current[accountId];
      if (cached) return cached;
      if (!parsed?.username) return null;
      const res: any = await previewChatFn({ data: { target: `@${parsed.username}`, accountId } });
      const pk: string | null = res?.peerKey ?? null;
      if (pk) peerKeyCache.current[accountId] = pk;
      return pk;
    },
    [botBtnState.perAccount, parsed?.username, previewChatFn],
  );

  // ─── Attachment broadcast (media library) ─────────────────────────
  const listMediaFn = useServerFn(listMedia);
  const sendMediaAsFn = useServerFn(sendMediaAs);
  const mediaQ = useQuery({
    queryKey: ["bot-flow-media"],
    queryFn: () => listMediaFn({} as any),
    staleTime: 60_000,
  });
  const mediaItems = (mediaQ.data ?? []) as Array<{
    id: string; name: string; path: string; filename: string; isVoice: boolean;
  }>;
  const [mediaId, setMediaId] = useState<string>("");
  const [mediaCaption, setMediaCaption] = useState("");
  const [sendingMedia, setSendingMedia] = useState(false);
  const broadcastMedia = useCallback(async () => {
    const item = mediaItems.find((m) => m.id === mediaId);
    if (!item) return toast.error("Pick a file from the media library first");
    if (chatOpen.length === 0) return toast.error("No open accounts");
    setSendingMedia(true);
    let ok = 0, fail = 0;
    await Promise.all(
      chatOpen.map(async (accountId) => {
        try {
          const peerKey = await resolvePeerKeyFor(accountId);
          if (!peerKey) { fail++; return; }
          await sendMediaAsFn({
            data: {
              accountId,
              peerKey,
              path: item.path,
              filename: item.filename,
              isVoice: item.isVoice,
              caption: mediaCaption.trim() || undefined,
            },
          });
          ok++;
        } catch {
          fail++;
        }
      }),
    );
    setSendingMedia(false);
    toast[fail && !ok ? "error" : "success"](`File sent → ok:${ok} fail:${fail}`);
    pingOpenChats();
    setTimeout(pingOpenChats, 2000);
  }, [mediaItems, mediaId, mediaCaption, chatOpen, resolvePeerKeyFor, sendMediaAsFn, pingOpenChats]);

  // ─── Sequence sender (scripted multi-step run) ────────────────────
  type SeqStep =
    | { kind: "text"; value: string }
    | { kind: "button"; value: string }
    | { kind: "wait"; seconds: number };
  const [seqSteps, setSeqSteps] = useState<SeqStep[]>([]);
  const [seqDraft, setSeqDraft] = useState("");
  const [seqKind, setSeqKind] = useState<"text" | "button" | "wait">("text");
  const [seqRunning, setSeqRunning] = useState(false);
  const [seqProgress, setSeqProgress] = useState<{ step: number; note: string } | null>(null);
  const seqAbort = useRef(false);

  const addSeqStep = () => {
    const v = seqDraft.trim();
    if (seqKind === "wait") {
      const s = Math.max(1, Math.min(300, Number(v) || 3));
      setSeqSteps((p) => [...p, { kind: "wait", seconds: s }]);
    } else {
      if (!v) return;
      setSeqSteps((p) => [...p, { kind: seqKind, value: v }]);
    }
    setSeqDraft("");
  };

  const runSequence = useCallback(async () => {
    if (!seqSteps.length) return toast.error("Add at least one step");
    if (chatOpen.length === 0) return toast.error("No open accounts");
    seqAbort.current = false;
    setSeqRunning(true);
    try {
      for (let i = 0; i < seqSteps.length; i++) {
        if (seqAbort.current) { toast.info("Sequence stopped"); break; }
        const step = seqSteps[i];
        if (step.kind === "wait") {
          setSeqProgress({ step: i + 1, note: `Waiting ${step.seconds}s…` });
          for (let s = 0; s < step.seconds * 4; s++) {
            if (seqAbort.current) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          continue;
        }
        if (step.kind === "text") {
          setSeqProgress({ step: i + 1, note: `Sending "${step.value}"` });
          let ok = 0, fail = 0;
          await Promise.all(
            chatOpen.map(async (accountId) => {
              try {
                const peerKey = await resolvePeerKeyFor(accountId);
                if (!peerKey) { fail++; return; }
                await sendMessageAsFn({ data: { accountId, peerKey, text: step.value } });
                ok++;
              } catch { fail++; }
            }),
          );
          setSeqProgress({ step: i + 1, note: `Sent "${step.value}" → ok:${ok} fail:${fail}` });
        } else {
          setSeqProgress({ step: i + 1, note: `Tapping "${step.value}"` });
          const fresh = await refreshBotButtons();
          let ok = 0, fail = 0, skip = 0;
          await Promise.all(
            Object.entries(fresh).map(async ([accountId, v]) => {
              const btn = v.buttons.find((b) => b.label === step.value);
              if (!btn) { skip++; return; }
              try {
                if (btn.kind === "callback" && btn.data) {
                  await pressInlineButtonAsFn({
                    data: { accountId, peerKey: v.peerKey, msgId: v.msgId, data: btn.data, buttonLabel: step.value },
                  });
                  ok++;
                } else if (btn.kind === "reply") {
                  await sendMessageAsFn({ data: { accountId, peerKey: v.peerKey, text: step.value } });
                  ok++;
                } else { skip++; }
              } catch { fail++; }
            }),
          );
          setSeqProgress({ step: i + 1, note: `Tapped "${step.value}" → ok:${ok} fail:${fail} skip:${skip}` });
        }
        pingOpenChats();
        await new Promise((r) => setTimeout(r, 800));
      }
    } finally {
      setSeqRunning(false);
      setSeqProgress(null);
      pingOpenChats();
      setTimeout(pingOpenChats, 2000);
    }
  }, [seqSteps, chatOpen, resolvePeerKeyFor, sendMessageAsFn, refreshBotButtons, pressInlineButtonAsFn, pingOpenChats]);

  // Auto-clear cached buttons when the set of open chats changes.
  useEffect(() => {
    setBotBtnState({ loading: false, labels: [], perAccount: {} });
  }, [chatOpen.length, parsed?.username]);

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
              <AccountRangeControls
                total={accountList.length}
                onApply={(s, e, order) => setSelectedIds(pickRange(accountList, s, e, order).map((a) => a.id))}
              />
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

          <div className="rounded-md border border-border bg-muted/20 p-2 space-y-2">
            <div className="text-xs font-medium">Open a mini app from a bot chat</div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={botChatMini}
                onChange={(e) => setBotChatMini(e.target.value)}
                placeholder={parsed?.username ? `@${parsed.username}` : "@somebot or https://t.me/somebot"}
                className="h-8 w-64 text-xs"
              />
              <Button
                size="sm"
                onClick={() =>
                  openMiniFromBot(
                    botChatMini || parsed?.username || "",
                    parsed?.startParam || "",
                    selectedIds.length ? selectedIds : allIds,
                  )
                }
                disabled={!botChatMini && !parsed?.username}
                title="Open this bot's mini app on every selected account"
              >
                <Play className="mr-1 h-3.5 w-3.5" /> Open mini app on selected
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Uses the same accounts selected above. Windows appear in “Open Mini App on many accounts”.
              </span>
            </div>
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
                  <div className="rounded-md border border-border bg-background/60 p-2 text-xs space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Broadcast a bot button</span>
                      <span className="text-muted-foreground">
                        · press once, fires on all {chatOpen.length} open account(s)
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        onClick={() => refreshBotButtons()}
                        disabled={botBtnState.loading}
                      >
                        {botBtnState.loading ? "Loading…" : botBtnState.labels.length ? "Refresh buttons" : "Load bot buttons"}
                      </Button>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={botBtnState.loading || botBtnOffset === 0}
                          onClick={() => {
                            const n = Math.max(0, botBtnOffset - 1);
                            setBotBtnOffset(n);
                            refreshBotButtons(n);
                          }}
                          title="Newer message"
                        >
                          ◀ Newer
                        </Button>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          msg −{botBtnOffset}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={botBtnState.loading}
                          onClick={() => {
                            const n = botBtnOffset + 1;
                            setBotBtnOffset(n);
                            refreshBotButtons(n);
                          }}
                          title="Older message with buttons"
                        >
                          Older ▶
                        </Button>
                      </div>
                    </div>
                    {botBtnState.labels.length > 0 && (
                      <>
                        <div className="flex flex-wrap gap-1.5">
                          {botBtnState.labels.map((b) => {
                            const supported =
                              b.kinds.includes("callback") || b.kinds.includes("reply");
                            const cover = Object.values(botBtnState.perAccount).filter((v) =>
                              v.buttons.some((x) => x.label === b.label),
                            ).length;
                            const total = Object.keys(botBtnState.perAccount).length;
                            const busy = pressingLabel === b.label;
                            return (
                              <button
                                key={b.label}
                                type="button"
                                disabled={!supported || busy}
                                onClick={() => broadcastPress(b.label)}
                                title={
                                  supported
                                    ? `Press "${b.label}" on ${cover}/${total} accounts`
                                    : `Not broadcastable (${b.kinds.join(", ")})`
                                }
                                className={
                                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] " +
                                  (supported
                                    ? "border-primary/40 bg-primary/10 hover:bg-primary/20"
                                    : "border-border bg-muted text-muted-foreground opacity-70") +
                                  (busy ? " animate-pulse" : "")
                                }
                              >
                                <span className="max-w-[220px] truncate">{b.label || "(unnamed)"}</span>
                                <span className="rounded bg-background/70 px-1 text-[10px] font-mono">
                                  {cover}/{total}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          Callback + reply-text buttons broadcast automatically. URL / WebApp
                          buttons stay per-account (open them inside each chat).
                        </div>
                      </>
                    )}
                  </div>
                  <div className="rounded-md border border-border bg-background/60 p-2 text-xs space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Broadcast a message</span>
                      <span className="text-muted-foreground">
                        · type once, sends from all {chatOpen.length} open account(s)
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={broadcastText}
                        onChange={(e) => setBroadcastText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            if (!broadcastingMsg) void broadcastMessage();
                          }
                        }}
                        placeholder="Message to send from every open account… (Enter to send)"
                        className="h-8 text-xs"
                        disabled={broadcastingMsg}
                      />
                      <Button
                        size="sm"
                        onClick={() => void broadcastMessage()}
                        disabled={broadcastingMsg || !broadcastText.trim()}
                      >
                        {broadcastingMsg ? "Sending…" : "Send to all"}
                      </Button>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      Sent as a normal message from each account to @{parsed.username} — chats stay connected and update live.
                    </div>
                  </div>
                  {/* ── Attachment broadcast ─────────────────────── */}
                  <div className="rounded-md border border-border bg-background/60 p-2 text-xs space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Send a file to all</span>
                      <span className="text-muted-foreground">· from your Media Library</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Select value={mediaId} onValueChange={setMediaId}>
                        <SelectTrigger className="h-8 w-[220px] text-xs">
                          <SelectValue placeholder={mediaItems.length ? "Pick a file…" : "Media library is empty"} />
                        </SelectTrigger>
                        <SelectContent>
                          {mediaItems.map((m) => (
                            <SelectItem key={m.id} value={m.id} className="text-xs">
                              {m.name}{m.isVoice ? " (voice)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={mediaCaption}
                        onChange={(e) => setMediaCaption(e.target.value)}
                        placeholder="Caption (optional)"
                        className="h-8 max-w-[280px] text-xs"
                        disabled={sendingMedia}
                      />
                      <Button size="sm" onClick={() => void broadcastMedia()} disabled={sendingMedia || !mediaId}>
                        {sendingMedia ? "Sending…" : "Send file to all"}
                      </Button>
                    </div>
                  </div>
                  {/* ── Sequence sender ──────────────────────────── */}
                  <div className="rounded-md border border-border bg-background/60 p-2 text-xs space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Sequence sender</span>
                      <span className="text-muted-foreground">
                        · script steps once, every open account runs them in order
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Select value={seqKind} onValueChange={(v) => setSeqKind(v as typeof seqKind)}>
                        <SelectTrigger className="h-8 w-[130px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text" className="text-xs">Send text</SelectItem>
                          <SelectItem value="button" className="text-xs">Tap button</SelectItem>
                          <SelectItem value="wait" className="text-xs">Wait (sec)</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        value={seqDraft}
                        onChange={(e) => setSeqDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); addSeqStep(); }
                        }}
                        placeholder={
                          seqKind === "wait" ? "Seconds, e.g. 5"
                            : seqKind === "button" ? "Exact button label"
                            : "Message text, e.g. /start"
                        }
                        className="h-8 max-w-[280px] text-xs"
                      />
                      <Button size="sm" variant="outline" onClick={addSeqStep}>Add step</Button>
                      {seqSteps.length > 0 && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => void runSequence()}
                            disabled={seqRunning}
                          >
                            {seqRunning ? "Running…" : `Run on ${chatOpen.length} account(s)`}
                          </Button>
                          {seqRunning ? (
                            <Button size="sm" variant="destructive" onClick={() => { seqAbort.current = true; }}>
                              Stop
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setSeqSteps([])}>Clear</Button>
                          )}
                        </>
                      )}
                    </div>
                    {seqSteps.length > 0 && (
                      <ol className="space-y-1">
                        {seqSteps.map((s, i) => (
                          <li
                            key={`${i}-${s.kind}`}
                            className={
                              "flex items-center gap-2 rounded border px-2 py-1 " +
                              (seqProgress?.step === i + 1
                                ? "border-primary/50 bg-primary/10"
                                : "border-border")
                            }
                          >
                            <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                            <span className="rounded bg-muted px-1 text-[10px] uppercase">{s.kind}</span>
                            <span className="min-w-0 flex-1 truncate">
                              {s.kind === "wait" ? `${s.seconds}s` : s.value}
                            </span>
                            <button
                              type="button"
                              className="rounded p-1 hover:bg-muted"
                              title="Remove step"
                              onClick={() => setSeqSteps((p) => p.filter((_, x) => x !== i))}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </li>
                        ))}
                      </ol>
                    )}
                    {seqProgress && (
                      <div className="text-[10px] text-primary">
                        Step {seqProgress.step}/{seqSteps.length} · {seqProgress.note}
                      </div>
                    )}
                    <div className="text-[10px] text-muted-foreground">
                      "Tap button" re-reads the bot's newest buttons before each press, so multi-step
                      flows (/start → wait → tap Verify) work end-to-end without reloading sessions.
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {visibleChatIds.map((id) => {
                    const a = accountList.find((x) => x.id === id);
                    const who = a?.first_name || a?.username || a?.phone || id.slice(0, 8);
                    const nonce = chatReload[id] ?? 0;
                    const src = `/accounts/${id}?peer=${encodeURIComponent(`@${parsed.username}`)}&solo=1${nonce ? `&r=${nonce}` : ""}`;
                    return (
                      <div key={`${id}:${nonce}`} className="flex h-[560px] flex-col overflow-hidden rounded-md border border-border bg-background">
                        <div className="flex items-center gap-2 border-b px-2 py-1.5">
                          <div className="min-w-0 flex-1 text-xs">
                            <div className="truncate font-semibold">{who}</div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              @{parsed.username}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-muted border border-border"
                            title="Re-run just this account from the start"
                            onClick={() => rerunChat(id)}
                          >
                            Re-run
                          </button>
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
                          ref={(el) => { chatFrames.current[id] = el; }}
                          title={`${who} — @${parsed.username}`}
                          className="h-full w-full flex-1 border-0"
                          loading="lazy"
                        />
                      </div>
                    );
                  })}
                  </div>
                  {queuedChatCount > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5 text-xs">
                      <span className="text-muted-foreground">
                        Showing {visibleChatIds.length} of {chatOpen.length} · {queuedChatCount} queued
                      </span>
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
                    </div>
                  )}
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

          <div className="rounded-md border border-border bg-background/50 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Switch checked={vxAutoSend} onCheckedChange={setVxAutoSend} id="vx-autosend" />
              <Label htmlFor="vx-autosend" className="cursor-pointer">
                Auto-send each extracted link to a chat (from the same account)
              </Label>
            </div>
            {vxAutoSend && (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <Label>Target chat / group / channel</Label>
                  <Input
                    value={vxTarget}
                    onChange={(e) => setVxTarget(e.target.value)}
                    placeholder="@mychannel  ·  https://t.me/mychannel  ·  c:123456789"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {vxTargetKey
                      ? <>Sends as <span className="font-mono text-foreground">{vxTargetKey}</span> — each account must already be a member.</>
                      : "Public @username, t.me link, or a peer key (u:/g:/c:)."}
                  </p>
                </div>
                <div>
                  <Label>Message template</Label>
                  <Input
                    value={vxTemplate}
                    onChange={(e) => setVxTemplate(e.target.value)}
                    placeholder="{link}"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use <code>{"{link}"}</code> as the placeholder for the extracted URL.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium mr-auto">
                {vxSelected.length} / {allIds.length} accounts selected
              </div>
              <AccountRangeControls
                total={accountList.length}
                onApply={(s, e, order) => setVxSelected(pickRange(accountList, s, e, order).map((a) => a.id))}
              />
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
                        {r.sent === "ok" && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase text-primary">sent</span>
                        )}
                        {r.sent === "fail" && (
                          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] uppercase text-destructive" title={r.sendError}>
                            send failed
                          </span>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>

        {/* ── Mini App launcher ─────────────────────────────────────── */}
        <CollapsibleSection
          storageKey="botflow.miniapp"
          title="Open Mini App on many accounts"
          defaultOpen={false}
          openSignal={miniOpenSignal}
        >
          <p className="text-xs text-muted-foreground">
            Paste a Telegram mini app link (e.g. <code>https://t.me/wormcupbot?startapp=R84L82W</code>).
            Each selected account gets its own live mini app window below — use them independently.
          </p>

          <div>
            <Label>Mini app link</Label>
            <Input
              value={miniLink}
              onChange={(e) => setMiniLink(e.target.value)}
              placeholder="https://t.me/somebot?startapp=YOUR_REF or @somebot"
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
              <AccountRangeControls
                total={accountList.length}
                onApply={(s, e, order) => setMiniSelected(pickRange(accountList, s, e, order).map((a) => a.id))}
              />
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
            <div className="ml-auto flex items-center gap-2 text-xs">
              <Label className="text-xs">Max live</Label>
              <Input
                type="number"
                min={1}
                max={12}
                value={miniLimit}
                onChange={(e) => setMiniLimit(Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 1)))}
                className="h-8 w-16"
              />
              <span className="text-muted-foreground">
                {miniMounted.size} live · {miniRuns.filter((r) => r.status === "ready" && !miniMounted.has(r.accountId)).length} queued
              </span>
            </div>
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
                      {r.status === "ready" && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted"
                          title={miniMounted.has(r.accountId) ? "Unload iframe (free resources)" : "Load this mini app"}
                          onClick={() => toggleMiniMount(r.accountId)}
                        >
                          {miniMounted.has(r.accountId) ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                          {miniMounted.has(r.accountId) ? "Unload" : "Load"}
                        </button>
                      )}
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
                       {r.status === "ready" && r.url && (miniMounted.has(r.accountId) ? (
                         <MiniAppFrame url={r.url} title={who} accountId={r.accountId} botUsername={miniParsed?.username ?? ""} />
                       ) : (
                         <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/30 p-3 text-center text-xs text-muted-foreground">
                           <div>Queued — mini-app not loaded to save resources.</div>
                           <Button size="sm" variant="outline" onClick={() => toggleMiniMount(r.accountId)}>
                             <Play className="mr-1 h-3.5 w-3.5" /> Load
                           </Button>
                         </div>
                       ))}
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
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [retrySeed, setRetrySeed] = useState(0);
  const [blocked, setBlocked] = useState<{ text?: string } | null>(null);
  const [directMode, setDirectMode] = useState(false);
  const [slowFallback, setSlowFallback] = useState(false);
  const { url: proxied } = useMiniAppProxyUrl(url, accountId, { fpSeed: retrySeed || undefined });
  useTelegramWebviewBridge(iframeRef, { onBlocked: (details) => setBlocked({ text: details.text }) });
  useEffect(() => {
    const src = directMode ? url : proxied;
    if (!src) return;
    setSlowFallback(false);
    const t = window.setTimeout(() => setSlowFallback(true), directMode ? 6500 : 8500);
    return () => window.clearTimeout(t);
  }, [url, proxied, directMode, retrySeed]);
  return (
    <div className="relative h-full w-full flex-1">
      <div className="absolute right-2 top-2 z-10 rounded-md border border-border bg-background/95 p-1 shadow-sm backdrop-blur">
        <Button
          size="sm"
          variant={directMode ? "secondary" : "outline"}
          className="h-7 px-2 text-[11px]"
          onClick={() => { setDirectMode((v) => !v); setBlocked(null); setRetrySeed(Date.now()); }}
        >
          {directMode ? "Direct device" : "Proxy mode"}
        </Button>
      </div>
      <iframe
        key={`${directMode ? "direct" : "proxy"}:${retrySeed}`}
        ref={iframeRef}
        src={directMode ? url : proxied ?? "about:blank"}
        title="Verification runner"
        className="h-full w-full flex-1 border-0"
        allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
        referrerPolicy="no-referrer-when-downgrade"
        onLoad={() => setSlowFallback(false)}
      />
      {slowFallback && !blocked && (
        <div className="absolute inset-x-3 bottom-3 rounded-lg border border-yellow-500/40 bg-background/95 p-3 text-xs shadow-lg backdrop-blur">
          <div className="mb-2 font-semibold">Verification is not responding here</div>
          <div className="mb-3 text-muted-foreground">
            This provider is rejecting embedded/proxy sessions. Use Telegram/System Browser for this link.
          </div>
          <div className="flex flex-wrap gap-2">
            {!directMode && (
              <Button size="sm" variant="secondary" onClick={() => { setDirectMode(true); setRetrySeed(Date.now()); }}>
                Try direct
              </Button>
            )}
            <BrowserPickerButton url={url} size="sm" variant="outline" />
          </div>
        </div>
      )}
      {blocked && (
        <div className="absolute inset-x-3 bottom-3 rounded-lg border border-border bg-background/95 p-3 text-xs shadow-lg backdrop-blur">
          <div className="mb-2 font-semibold">Verification blocked in embedded view</div>
          <div className="mb-3 line-clamp-2 text-muted-foreground">{blocked.text || "The verification site rejected the proxy session."}</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setBlocked(null); setRetrySeed(Date.now()); }}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry new device
            </Button>
            {!directMode && (
              <Button size="sm" variant="outline" onClick={() => { setDirectMode(true); setBlocked(null); setRetrySeed(Date.now()); }}>
                Direct device mode
              </Button>
            )}
            <BrowserPickerButton url={url} size="sm" variant="outline" />
          </div>
        </div>
      )}
    </div>
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
  accountList: Array<{
    id: string;
    first_name?: string | null;
    username?: string | null;
    phone?: string | null;
    telegram_user_id?: string | number | null;
  }>;
}) {
  type LinkEntry = { id: string; url: string; accountOverride?: string | null };
  const mkEntry = (url = ""): LinkEntry => ({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    url,
  });
  const [entries, setEntries] = useState<LinkEntry[]>([mkEntry()]);
  const [selected, setSelected] = useState<string[]>([]);
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [runNonce, setRunNonce] = useState(0);
  const [openLogs, setOpenLogs] = useState<Record<string, boolean>>({});
  const [stableDevice, setStableDevice] = useState(true);
  const [directMode, setDirectMode] = useState(false);
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

  const normalizeUrl = (raw: string) => {
    const s = raw.trim();
    if (!s) return "";
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    try { new URL(withProto); return withProto; } catch { return ""; }
  };
  const parsedEntries = useMemo(
    () =>
      entries
        .map((e) => ({ ...e, normalized: normalizeUrl(e.url) }))
        .filter((e) => !!e.normalized),
    [entries],
  );
  const parsedLinks = useMemo(() => parsedEntries.map((e) => e.normalized), [parsedEntries]);

  const updateEntry = (id: string, patch: Partial<LinkEntry>) => {
    setEntries((prev) => {
      const next = prev.map((e) => (e.id === id ? { ...e, ...patch } : e));
      const trimmed: LinkEntry[] = [];
      for (let i = 0; i < next.length; i++) {
        const cur = next[i];
        const isLast = i === next.length - 1;
        if (!cur.url.trim() && !isLast) continue;
        trimmed.push(cur);
      }
      if (!trimmed.length || trimmed[trimmed.length - 1].url.trim() !== "") {
        trimmed.push(mkEntry());
      }
      return trimmed;
    });
  };
  const removeEntry = (id: string) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      if (!next.length || next[next.length - 1].url.trim() !== "") next.push(mkEntry());
      return next;
    });
  };
  const clearEntries = () => setEntries([mkEntry()]);
  const pasteMany = (raw: string, targetId: string) => {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) return false;
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === targetId);
      const insertion = lines.map((u) => mkEntry(u));
      const before = idx >= 0 ? prev.slice(0, idx) : prev;
      const afterRaw = idx >= 0 ? prev.slice(idx + 1) : [];
      const after = afterRaw.filter((e) => e.url.trim() !== "");
      const merged = [...before, ...insertion, ...after];
      if (!merged.length || merged[merged.length - 1].url.trim() !== "") merged.push(mkEntry());
      return merged;
    });
    return true;
  };

  const entryAccountFor = (normalized: string): string | null => {
    const s = parseVerifyLinkSession(normalized);
    if (!s.userId) return null;
    const m = accountList.find(
      (a) => a.telegram_user_id != null && String(a.telegram_user_id) === s.userId,
    );
    return m ? m.id : null;
  };

  const toggleAcc = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectAll = () => setSelected(accountList.map((a) => a.id));
  const selectNone = () => setSelected([]);

  const buildRows = () => {
    if (!parsedEntries.length) return toast.error("Add at least one verification link");
    const pool = selected.length ? selected : accountList.map((a) => a.id);
    const salt = Date.now().toString(36);
    let rr = 0;
    const built: BulkRow[] = [];
    for (let i = 0; i < parsedEntries.length; i++) {
      const e = parsedEntries[i];
      const auto = entryAccountFor(e.normalized);
      const accountId =
        e.accountOverride || auto || (pool.length ? pool[rr++ % pool.length] : "");
      if (!accountId) {
        return toast.error("Select accounts, or use links with an embedded Telegram user id");
      }
      built.push({
        id: `${salt}-${i}`,
        url: e.normalized,
        accountId,
        fpSeed: stableDevice
          ? stableSeedFor(accountId)
          : `${salt}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        status: "queued" as BulkRowStatus,
        logs: [] as BulkRowLog[],
      });
    }
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

      <label className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={directMode}
          onChange={(e) => setDirectMode(e.target.checked)}
        />
        <span>
          <span className="font-medium">Direct device mode</span>{" "}
          <span className="text-muted-foreground">
            Opens verification URLs from your browser/IP instead of the server proxy for sites that show “Telegram Required” or “Connection Lost”.
          </span>
        </span>
      </label>

      <div className="grid gap-3 md:grid-cols-[1fr_260px]">
        <div>
          <div className="flex items-center justify-between">
            <Label>Verification links</Label>
            {entries.some((e) => e.url.trim()) && (
              <button
                type="button"
                className="text-[11px] underline text-muted-foreground"
                onClick={clearEntries}
              >
                Clear all
              </button>
            )}
          </div>
          <div className="mt-1 space-y-2">
            {entries.map((e, idx) => {
              const normalized = normalizeUrl(e.url);
              const auto = normalized ? entryAccountFor(normalized) : null;
              const chosenId = e.accountOverride || auto || "";
              const chosen = chosenId ? accountList.find((a) => a.id === chosenId) : null;
              const chosenLabel = chosen
                ? (chosen.first_name || chosen.username || chosen.phone || chosen.id.slice(0, 8))
                : "";
              const isLastEmpty = idx === entries.length - 1 && !e.url.trim();
              return (
                <div key={e.id} className="rounded-md border border-border bg-background p-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-1.5 w-5 shrink-0 text-center text-[10px] text-muted-foreground">
                      {idx + 1}
                    </span>
                    <div className="flex-1">
                      <Input
                        value={e.url}
                        onChange={(ev) => updateEntry(e.id, { url: ev.target.value })}
                        onPaste={(ev) => {
                          const raw = ev.clipboardData.getData("text");
                          if (pasteMany(raw, e.id)) ev.preventDefault();
                        }}
                        placeholder={
                          idx === 0
                            ? "https://bots.example.com/verify/xyz#tgWebAppData=..."
                            : "Paste another link…"
                        }
                        className="font-mono text-xs"
                      />
                      {normalized && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                          {auto ? (
                            <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-600 dark:text-green-400">
                              auto → {chosenLabel}
                            </span>
                          ) : (
                            <span className="rounded bg-muted px-1.5 py-0.5">
                              round-robin{chosenLabel ? ` → ${chosenLabel}` : ""}
                            </span>
                          )}
                          <select
                            className="rounded border border-input bg-background px-1 py-0.5 text-[10px]"
                            value={e.accountOverride || ""}
                            onChange={(ev) =>
                              updateEntry(e.id, { accountOverride: ev.target.value || null })
                            }
                          >
                            <option value="">
                              {auto ? `keep auto (${chosenLabel})` : "auto / round-robin"}
                            </option>
                            {accountList.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.first_name || a.username || a.phone || a.id.slice(0, 8)}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                    {!isLastEmpty && (
                      <button
                        type="button"
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted"
                        title="Remove"
                        onClick={() => removeEntry(e.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {parsedLinks.length} valid link(s) ·{" "}
            {parsedEntries.filter((e) => entryAccountFor(e.normalized)).length} auto-matched
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
                  directMode={directMode}
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
  directMode,
  iframeRef,
  onLoaded,
}: {
  url: string;
  accountId: string;
  fpSeed: string;
  directMode: boolean;
  iframeRef?: (el: HTMLIFrameElement | null) => void;
  onLoaded?: () => void;
}) {
  const localRef = useRef<HTMLIFrameElement | null>(null);
  const [retrySeed, setRetrySeed] = useState(fpSeed);
  const [blocked, setBlocked] = useState<{ text?: string } | null>(null);
  const [slowFallback, setSlowFallback] = useState(false);
  const { url: proxied } = useMiniAppProxyUrl(url, accountId, { fpSeed: retrySeed });
  const bridge = useTelegramWebviewBridge(localRef, { onBlocked: (details) => setBlocked({ text: details.text }) });
  useEffect(() => {
    const src = directMode ? url : proxied;
    if (!src) return;
    setSlowFallback(false);
    const t = window.setTimeout(() => setSlowFallback(true), directMode ? 6500 : 8500);
    return () => window.clearTimeout(t);
  }, [url, proxied, directMode, retrySeed]);
  return (
    <div className="relative h-full w-full flex-1">
      <iframe
        key={`${directMode ? "direct" : "proxy"}:${retrySeed}`}
        ref={(el) => {
          localRef.current = el;
          iframeRef?.(el);
        }}
        src={directMode ? url : proxied ?? "about:blank"}
        title="Bulk verification runner"
        className="h-full w-full flex-1 border-0"
        allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
        referrerPolicy="no-referrer-when-downgrade"
        onLoad={() => { setSlowFallback(false); onLoaded?.(); }}
      />
      <MiniAppChrome bridge={bridge} />
      {slowFallback && !blocked && (
        <div className="absolute inset-x-2 bottom-2 rounded-lg border border-yellow-500/40 bg-background/95 p-2 text-[11px] shadow-lg backdrop-blur">
          <div className="mb-1 font-semibold">No response in embedded view</div>
          <div className="mb-2 text-muted-foreground">Open this row in Telegram/System Browser.</div>
          <BrowserPickerButton url={url} size="sm" variant="outline" />
        </div>
      )}
      {blocked && (
        <div className="absolute inset-x-2 bottom-2 rounded-lg border border-border bg-background/95 p-2 text-[11px] shadow-lg backdrop-blur">
          <div className="mb-1 font-semibold">Blocked in embedded view</div>
          <div className="mb-2 line-clamp-2 text-muted-foreground">{blocked.text || "The verification site rejected this session."}</div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => { setBlocked(null); setRetrySeed(`${fpSeed}:${Date.now()}`); }}>
              <RefreshCw className="mr-1 h-3 w-3" /> Retry
            </Button>
            <BrowserPickerButton url={url} size="sm" variant="outline" />
          </div>
        </div>
      )}
    </div>
  );
}

function MiniAppFrameImpl({ url, title, accountId, botUsername }: { url: string; title: string; accountId: string; botUsername: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const joinFn = useServerFn(joinFromLink);
  const { url: proxiedUrl } = useMiniAppProxyUrl(url, accountId);
  const [nonce, setNonce] = useState(0);
  const [directMode, setDirectMode] = useState(false);
  const [overlay, setOverlay] = useState<
    | { status: "loading"; url: string }
    | { status: "ready"; url: string; peerKey: string; title: string; note: string }
    | { status: "requested"; url: string; title: string; note: string }
    | { status: "error"; url: string; error: string }
    | null
  >(null);
  const bridge = useTelegramWebviewBridge(ref, {
    onBlocked: (details) => setOverlay({ status: "error", url, error: details.text || "Verification blocked in embedded view" }),
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
          if (res.requested) {
            setOverlay({
              status: "requested",
              url: link,
              title: res.title,
              note: "Join request sent — waiting for admin approval",
            });
            return;
          }
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
        src={directMode ? url : proxiedUrl ?? "about:blank"}
        title={title}
        name={`tgminiapp-${accountId}`}
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write; camera; microphone; geolocation; payment"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
        referrerPolicy="no-referrer-when-downgrade"
      />
      <MiniAppChrome bridge={bridge} />
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
                {overlay.status === "ready" || overlay.status === "requested" ? overlay.title : "Opening…"}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {overlay.status === "ready" || overlay.status === "requested" ? overlay.note : overlay.url}
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
              <div className="space-y-3 p-3 text-xs">
                <div className="text-destructive">{overlay.error}</div>
                <div className="flex flex-wrap gap-2">
                  {!directMode && (
                    <Button size="sm" variant="outline" onClick={() => { setDirectMode(true); setOverlay(null); setNonce((n) => n + 1); }}>
                      Direct device mode
                    </Button>
                  )}
                  <BrowserPickerButton url={overlay.url} size="sm" variant="outline" />
                </div>
              </div>
            )}
            {overlay.status === "requested" && (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs">
                <UserPlus className="h-8 w-8 text-primary" />
                <div className="text-sm font-semibold">Join request sent</div>
                <div className="max-w-xs text-muted-foreground">{overlay.note}</div>
                <Button size="sm" variant="outline" onClick={() => setOverlay(null)}>
                  Back to verification
                </Button>
              </div>
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