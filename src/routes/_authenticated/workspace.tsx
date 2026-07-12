import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { listAccounts } from "@/lib/accounts.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminGate } from "@/components/AdminGate";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowLeft, X, Plus, LayoutGrid, Columns2, Columns3, Square, RefreshCw, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/_authenticated/workspace")({
  head: () => ({ meta: [{ title: "Multi-account workspace — TeleManager Pro" }] }),
  component: () => <AdminGate><Workspace /></AdminGate>,
});

const TABS_KEY = "tm.workspace.tabs.v1";
const ACTIVE_KEY = "tm.workspace.active.v1";
const PANES_KEY = "tm.workspace.panes.v1";
const PIN_KEY = "tm.workspace.pinned.v1";

type Account = { id: string; first_name?: string | null; username?: string | null; phone?: string | null };

function loadJson<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function saveJson<T>(k: string, v: T) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

function nameFor(a: Account | undefined, id: string) {
  if (!a) return id.slice(0, 6);
  return a.first_name || a.username || a.phone || id.slice(0, 6);
}

function Workspace() {
  const listFn = useServerFn(listAccounts);
  const accountsQ = useQuery({ queryKey: ["accounts"], queryFn: () => listFn() });
  const accounts: Account[] = (accountsQ.data ?? []) as Account[];
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const [tabs, setTabs] = useState<string[]>(() => loadJson<string[]>(TABS_KEY, []));
  const [active, setActive] = useState<string | null>(() => loadJson<string | null>(ACTIVE_KEY, null));
  const [panes, setPanes] = useState<1 | 2 | 3 | 4>(() => (loadJson<number>(PANES_KEY, 1) as 1 | 2 | 3 | 4));
  const [pinned, setPinned] = useState<(string | null)[]>(() => loadJson<(string | null)[]>(PIN_KEY, [null, null, null, null]));
  const [reloadKey, setReloadKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  useEffect(() => saveJson(TABS_KEY, tabs), [tabs]);
  useEffect(() => saveJson(ACTIVE_KEY, active), [active]);
  useEffect(() => saveJson(PANES_KEY, panes), [panes]);
  useEffect(() => saveJson(PIN_KEY, pinned), [pinned]);

  const openTab = (id: string) => {
    setTabs((t) => (t.includes(id) ? t : [...t, id]));
    setActive(id);
    setPickerOpen(false);
    setPickerQuery("");
  };
  const closeTab = (id: string) => {
    setTabs((t) => {
      const nt = t.filter((x) => x !== id);
      if (active === id) setActive(nt[nt.length - 1] ?? null);
      return nt;
    });
    setPinned((p) => p.map((x) => (x === id ? null : x)));
  };
  const setPane = (idx: number, id: string | null) => {
    setPinned((p) => { const c = [...p]; c[idx] = id; return c; });
  };

  const paneIds: (string | null)[] = useMemo(() => {
    const out: (string | null)[] = [];
    for (let i = 0; i < panes; i++) {
      // Pane 0 always follows the active tab unless it is pinned explicitly.
      if (i === 0) out.push(pinned[0] ?? active);
      else out.push(pinned[i] ?? null);
    }
    return out;
  }, [panes, pinned, active]);

  const availableForPicker = useMemo(() => {
    const q = pickerQuery.toLowerCase().trim();
    return accounts
      .filter((a) => !tabs.includes(a.id))
      .filter((a) => !q || nameFor(a, a.id).toLowerCase().includes(q))
      .slice(0, 100);
  }, [accounts, tabs, pickerQuery]);

  const gridClass = panes === 1 ? "grid-cols-1" : panes === 2 ? "grid-cols-2" : panes === 3 ? "grid-cols-3" : "grid-cols-2 grid-rows-2";

  return (
    <main className="flex h-screen flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="flex items-center gap-2 px-3 py-2">
          <Link to="/dashboard"><Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />Back</Button></Link>
          <h1 className="mr-2 text-sm font-semibold">Workspace</h1>

          <div className="ml-auto flex items-center gap-1">
            <span className="mr-1 text-[11px] text-muted-foreground">Panes:</span>
            <PaneBtn active={panes === 1} onClick={() => setPanes(1)}><Square className="h-3.5 w-3.5" /></PaneBtn>
            <PaneBtn active={panes === 2} onClick={() => setPanes(2)}><Columns2 className="h-3.5 w-3.5" /></PaneBtn>
            <PaneBtn active={panes === 3} onClick={() => setPanes(3)}><Columns3 className="h-3.5 w-3.5" /></PaneBtn>
            <PaneBtn active={panes === 4} onClick={() => setPanes(4)}><LayoutGrid className="h-3.5 w-3.5" /></PaneBtn>
            <Button size="sm" variant="ghost" onClick={() => setReloadKey((k) => k + 1)} title="Reload all panes">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto border-t border-border px-2 py-1">
          {tabs.map((id) => {
            const a = byId.get(id);
            const isActive = id === active;
            return (
              <div
                key={id}
                className={`group flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${isActive ? "border-primary bg-primary/10" : "border-border bg-muted/30 hover:bg-muted/60"}`}
              >
                <button className="max-w-[160px] truncate" onClick={() => setActive(id)} title={nameFor(a, id)}>
                  {nameFor(a, id)}
                </button>
                <button
                  className="opacity-50 hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); closeTab(id); }}
                  title="Close tab"
                ><X className="h-3 w-3" /></button>
              </div>
            );
          })}

          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 gap-1"><Plus className="h-3.5 w-3.5" />Add tab</Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <Input
                placeholder="Search accounts…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                className="mb-2 h-8 text-xs"
                autoFocus
              />
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {availableForPicker.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => openTab(a.id)}
                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted"
                  >
                    <span className="truncate">{nameFor(a, a.id)}</span>
                    <span className="text-muted-foreground">{a.phone ?? ""}</span>
                  </button>
                ))}
                {!availableForPicker.length && (
                  <div className="p-2 text-xs text-muted-foreground">
                    {accounts.length ? "All accounts already open." : "No accounts yet."}
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>

          {!tabs.length && (
            <span className="ml-2 text-xs text-muted-foreground">
              Open one or more accounts to start. Tabs persist across visits.
            </span>
          )}
        </div>
      </header>

      <div className={`grid flex-1 gap-1 bg-border p-1 ${gridClass}`}>
        {paneIds.map((id, idx) => (
          <Pane
            key={`${idx}-${reloadKey}`}
            index={idx}
            paneId={id}
            tabs={tabs}
            accounts={accounts}
            onPickPane={(newId) => setPane(idx, newId)}
            active={active}
            isFollowingActive={idx === 0 && pinned[0] == null}
            onDetach={() => setPane(idx, null)}
          />
        ))}
      </div>
    </main>
  );
}

function PaneBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded p-1.5 text-xs ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
    >{children}</button>
  );
}

function Pane(props: {
  index: number;
  paneId: string | null;
  tabs: string[];
  accounts: Account[];
  active: string | null;
  isFollowingActive: boolean;
  onPickPane: (id: string | null) => void;
  onDetach: () => void;
}) {
  const { index, paneId, tabs, accounts, isFollowingActive, onPickPane, onDetach } = props;
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const [reloadTick, setReloadTick] = useState(0);

  if (!paneId) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded bg-background p-4 text-center text-xs text-muted-foreground">
        <div className="text-sm font-medium text-foreground">Pane {index + 1}</div>
        <div>Pick an open tab to pin here:</div>
        <div className="flex flex-wrap justify-center gap-1">
          {tabs.map((id) => (
            <button
              key={id}
              onClick={() => onPickPane(id)}
              className="rounded border border-border px-2 py-1 hover:bg-muted"
            >{nameFor(byId.get(id), id)}</button>
          ))}
          {!tabs.length && <span>No tabs open yet.</span>}
        </div>
      </div>
    );
  }

  const a = byId.get(paneId);
  return (
    <div className="flex flex-col overflow-hidden rounded bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1 text-xs">
        <span className="truncate font-medium">{nameFor(a, paneId)}</span>
        {isFollowingActive && <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">follows active</span>}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setReloadTick((t) => t + 1)}
            className="rounded p-1 hover:bg-muted"
            title="Refresh this pane"
          ><RefreshCw className="h-3 w-3" /></button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px]">Pin…</Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="end">
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {tabs.map((id) => (
                  <button
                    key={id}
                    onClick={() => onPickPane(id)}
                    className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted ${paneId === id ? "bg-muted" : ""}`}
                  >
                    <span className="truncate">{nameFor(byId.get(id), id)}</span>
                  </button>
                ))}
                {index === 0 && (
                  <button
                    onClick={onDetach}
                    className="mt-1 w-full rounded border-t border-border px-2 pt-1 text-left text-xs text-muted-foreground hover:bg-muted"
                  >Follow active tab</button>
                )}
              </div>
            </PopoverContent>
          </Popover>
          <a
            href={`/accounts/${paneId}`}
            target="_blank"
            rel="noreferrer"
            className="rounded p-1 hover:bg-muted"
            title="Open full page"
          ><ExternalLink className="h-3 w-3" /></a>
        </div>
      </div>
      <iframe
        key={`${paneId}-${reloadTick}`}
        src={`/accounts/${paneId}?solo=1`}
        className="flex-1 border-0"
        title={`Account ${nameFor(a, paneId)}`}
      />
    </div>
  );
}