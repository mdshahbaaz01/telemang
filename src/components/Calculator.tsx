import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Op = "+" | "-" | "×" | "÷";

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
    setExpression(`${format(previous)} ${op} ${format(current)} =`);
    setDisplay(format(result));
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

  return (
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
  );
}