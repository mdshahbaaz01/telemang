import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Op = "+" | "-" | "×" | "÷";

export type HistoryEntry = {
  id: string;
  expression: string;
  result: string;
};

const STORAGE_KEY = "calc-history-v1";

function compute(a: number, b: number, op: Op): number {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "×":
      return a * b;
    case "÷":
      return b === 0 ? NaN : a / b;
  }
}

function format(n: number): string {
  if (!isFinite(n)) return "Error";
  const s = Number(n.toPrecision(12)).toString();
  return s;
}

export function Calculator() {
  const [display, setDisplay] = useState("0");
  const [previous, setPrevious] = useState<number | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [expression, setExpression] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");

  // Load history from localStorage after mount (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      // ignore
    }
  }, [history]);

  const inputDigit = useCallback(
    (d: string) => {
      if (waiting) {
        setDisplay(d);
        setWaiting(false);
      } else {
        setDisplay((cur) => (cur === "0" ? d : cur + d));
      }
    },
    [waiting],
  );

  const inputDot = useCallback(() => {
    if (waiting) {
      setDisplay("0.");
      setWaiting(false);
      return;
    }
    setDisplay((cur) => (cur.includes(".") ? cur : cur + "."));
  }, [waiting]);

  const clearAll = useCallback(() => {
    setDisplay("0");
    setPrevious(null);
    setOp(null);
    setWaiting(false);
    setExpression("");
  }, []);

  const deleteLast = useCallback(() => {
    if (waiting) return;
    setDisplay((cur) => {
      if (cur.length <= 1 || (cur.length === 2 && cur.startsWith("-"))) return "0";
      return cur.slice(0, -1);
    });
  }, [waiting]);

  const toggleSign = useCallback(() => {
    setDisplay((cur) => {
      if (cur === "0") return cur;
      return cur.startsWith("-") ? cur.slice(1) : "-" + cur;
    });
  }, []);

  const percent = useCallback(() => {
    setDisplay((cur) => format(parseFloat(cur) / 100));
  }, []);

  const performOp = useCallback(
    (next: Op) => {
      const current = parseFloat(display);
      if (previous !== null && op && !waiting) {
        const result = compute(previous, current, op);
        const formatted = format(result);
        setDisplay(formatted);
        setPrevious(result);
        setExpression(`${formatted} ${next}`);
      } else {
        setPrevious(current);
        setExpression(`${display} ${next}`);
      }
      setOp(next);
      setWaiting(true);
    },
    [display, previous, op, waiting],
  );

  const equals = useCallback(() => {
    if (previous === null || op === null) return;
    const current = parseFloat(display);
    const result = compute(previous, current, op);
    const expr = `${format(previous)} ${op} ${format(current)}`;
    const resStr = format(result);
    setExpression(`${expr} =`);
    setDisplay(resStr);
    if (resStr !== "Error") {
      setHistory((h) => [
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, expression: expr, result: resStr },
        ...h,
      ].slice(0, 50));
    }
    setPrevious(null);
    setOp(null);
    setWaiting(true);
  }, [display, previous, op]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const k = e.key;
      if (/^[0-9]$/.test(k)) {
        inputDigit(k);
      } else if (k === ".") {
        inputDot();
      } else if (k === "+" || k === "-") {
        performOp(k);
      } else if (k === "*") {
        performOp("×");
      } else if (k === "/") {
        e.preventDefault();
        performOp("÷");
      } else if (k === "Enter" || k === "=") {
        e.preventDefault();
        equals();
      } else if (k === "Backspace") {
        deleteLast();
      } else if (k === "Escape") {
        clearAll();
      } else if (k === "%") {
        percent();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [inputDigit, inputDot, performOp, equals, deleteLast, clearAll, percent]);

  const btn =
    "h-16 rounded-2xl text-xl font-medium transition-all active:scale-95 select-none";
  const numBtn = cn(btn, "bg-secondary text-secondary-foreground hover:bg-secondary/80");
  const fnBtn = cn(btn, "bg-muted text-muted-foreground hover:bg-muted/70");
  const opBtn = cn(btn, "bg-primary text-primary-foreground hover:bg-primary/90");
  const eqBtn = cn(btn, "bg-foreground text-background hover:opacity-90");

  const useHistoryResult = (r: string) => {
    setDisplay(r);
    setPrevious(null);
    setOp(null);
    setWaiting(true);
    setExpression("");
  };

  const clearHistory = () => setHistory([]);

  const q = historyQuery.trim().toLowerCase();
  const filteredHistory = q
    ? history.filter(
        (h) =>
          h.expression.toLowerCase().includes(q) ||
          h.result.toLowerCase().includes(q),
      )
    : history;

  return (
    <div className="flex w-full flex-col gap-4 md:flex-row md:items-start md:justify-center">
      <div className="w-full max-w-sm rounded-3xl bg-card p-5 shadow-2xl border border-border">
      <div className="mb-5 rounded-2xl bg-background/50 px-4 py-6 text-right">
        <div className="h-5 text-sm text-muted-foreground truncate">{expression}</div>
        <div className="mt-1 text-5xl font-light tracking-tight text-foreground truncate">
          {display}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <button className={fnBtn} onClick={clearAll} aria-label="Clear">
          AC
        </button>
        <button className={fnBtn} onClick={toggleSign} aria-label="Toggle sign">
          ±
        </button>
        <button className={fnBtn} onClick={percent} aria-label="Percent">
          %
        </button>
        <button className={opBtn} onClick={() => performOp("÷")} aria-label="Divide">
          ÷
        </button>

        {["7", "8", "9"].map((d) => (
          <button key={d} className={numBtn} onClick={() => inputDigit(d)}>
            {d}
          </button>
        ))}
        <button className={opBtn} onClick={() => performOp("×")} aria-label="Multiply">
          ×
        </button>

        {["4", "5", "6"].map((d) => (
          <button key={d} className={numBtn} onClick={() => inputDigit(d)}>
            {d}
          </button>
        ))}
        <button className={opBtn} onClick={() => performOp("-")} aria-label="Subtract">
          −
        </button>

        {["1", "2", "3"].map((d) => (
          <button key={d} className={numBtn} onClick={() => inputDigit(d)}>
            {d}
          </button>
        ))}
        <button className={opBtn} onClick={() => performOp("+")} aria-label="Add">
          +
        </button>

        <button className={cn(numBtn, "col-span-2")} onClick={() => inputDigit("0")}>
          0
        </button>
        <button className={numBtn} onClick={inputDot}>
          .
        </button>
        <button className={eqBtn} onClick={equals} aria-label="Equals">
          =
        </button>

        <button
          className={cn(fnBtn, "col-span-4")}
          onClick={deleteLast}
          aria-label="Delete"
        >
          ⌫ Delete
        </button>
      </div>
      </div>

      <aside className="w-full max-w-sm rounded-3xl bg-card p-5 shadow-2xl border border-border md:w-72">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            History
          </h2>
          <button
            onClick={clearHistory}
            disabled={history.length === 0}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Clear
          </button>
        </div>
        <div className="relative mb-3">
          <input
            type="text"
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            disabled={history.length === 0}
            placeholder="Search history…"
            aria-label="Search history"
            className="w-full rounded-xl border border-border bg-background/50 px-3 py-2 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
          {historyQuery && (
            <button
              onClick={() => setHistoryQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-muted"
            >
              ×
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No calculations yet.
          </p>
        ) : filteredHistory.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No matches for "{historyQuery}".
          </p>
        ) : (
          <ul className="max-h-96 space-y-1 overflow-y-auto pr-1">
            {filteredHistory.map((h) => (
              <li key={h.id}>
                <button
                  onClick={() => useHistoryResult(h.result)}
                  className="w-full rounded-xl px-3 py-2 text-right transition-colors hover:bg-muted"
                  title="Use this result"
                >
                  <div className="text-xs text-muted-foreground truncate">
                    {h.expression} =
                  </div>
                  <div className="text-lg font-medium text-foreground truncate">
                    {h.result}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}