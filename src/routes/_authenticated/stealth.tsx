import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { EyeOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/stealth")({
  component: StealthPage,
});

export type StealthSettings = {
  readReceiptEnabled: boolean;
  readReceiptMinMs: number;
  readReceiptMaxMs: number;
};

const KEY = "stealth-settings-v1";
const DEFAULTS: StealthSettings = {
  readReceiptEnabled: true,
  readReceiptMinMs: 2000,
  readReceiptMaxMs: 12000,
};

export function getStealthSettings(): StealthSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StealthSettings>) };
  } catch {
    return DEFAULTS;
  }
}

function StealthPage() {
  const [s, setS] = useState<StealthSettings>(DEFAULTS);

  useEffect(() => {
    setS(getStealthSettings());
  }, []);

  const save = () => {
    if (s.readReceiptMinMs < 0 || s.readReceiptMaxMs < s.readReceiptMinMs) {
      return toast.error("Max must be ≥ Min, both ≥ 0");
    }
    localStorage.setItem(KEY, JSON.stringify(s));
    toast.success("Saved");
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <EyeOff className="h-6 w-6" /> Stealth Settings
      </h1>
      <p className="text-sm text-muted-foreground">
        Make automated activity feel human. These settings apply on this browser.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Read-receipt naturalizer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={s.readReceiptEnabled}
              onCheckedChange={(v) => setS({ ...s, readReceiptEnabled: !!v })}
            />
            Delay marking chats as read after opening
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>Min delay (ms)</Label>
              <Input
                type="number"
                min={0}
                value={s.readReceiptMinMs}
                onChange={(e) => setS({ ...s, readReceiptMinMs: Math.max(0, +e.target.value || 0) })}
                disabled={!s.readReceiptEnabled}
              />
            </div>
            <div>
              <Label>Max delay (ms)</Label>
              <Input
                type="number"
                min={0}
                value={s.readReceiptMaxMs}
                onChange={(e) => setS({ ...s, readReceiptMaxMs: Math.max(0, +e.target.value || 0) })}
                disabled={!s.readReceiptEnabled}
              />
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            When you open a chat in Account Viewer / Workspace, the read receipt is delayed by a random time between
            Min and Max — mimicking the pause a real human takes to notice a new message. Disable to mark instantly.
          </div>
          <Button onClick={save}>Save</Button>
        </CardContent>
      </Card>
    </div>
  );
}
