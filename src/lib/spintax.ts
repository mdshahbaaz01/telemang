// Spintax + variable rendering for outgoing messages.
// Syntax:
//   {a|b|c}                  → random pick (nested supported)
//   {first_name} {last_name} {username} {n} {account_index} {account_name}

export type SpintaxVars = Partial<{
  first_name: string;
  last_name: string;
  username: string;
  n: string | number;
  account_index: string | number;
  account_name: string;
}>;

const TOKEN_KEYS: (keyof SpintaxVars)[] = [
  "first_name",
  "last_name",
  "username",
  "n",
  "account_index",
  "account_name",
];

function pickBranch(inner: string): string {
  // inner has no unbalanced braces because caller matched pairs.
  // Split on '|' at depth 0.
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of inner) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "|" && depth === 0) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);
  return parts[Math.floor(Math.random() * parts.length)];
}

function isTokenGroup(inner: string): boolean {
  const t = inner.trim();
  return (TOKEN_KEYS as string[]).includes(t);
}

function expandOnce(input: string, vars: SpintaxVars): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "{") {
      out += ch;
      i++;
      continue;
    }
    // find matching close
    let depth = 1;
    let j = i + 1;
    while (j < input.length && depth > 0) {
      if (input[j] === "{") depth++;
      else if (input[j] === "}") depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) {
      out += ch;
      i++;
      continue;
    }
    const inner = input.slice(i + 1, j);
    if (isTokenGroup(inner)) {
      const key = inner.trim() as keyof SpintaxVars;
      const v = vars[key];
      out += v == null ? "" : String(v);
    } else if (inner.includes("|")) {
      out += pickBranch(inner);
    } else {
      // Not a recognized token, keep as-is (e.g. HTML fragments should not go through here).
      out += input.slice(i, j + 1);
    }
    i = j + 1;
  }
  return out;
}

export function renderSpintax(input: string, vars: SpintaxVars = {}): string {
  if (!input) return input;
  // Iterate until fixed point (max 5) to expand nested picks.
  let cur = input;
  for (let k = 0; k < 5; k++) {
    const next = expandOnce(cur, vars);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

export function appendSignature(body: string, signature?: string | null): string {
  const sig = (signature ?? "").trim();
  if (!sig) return body;
  return `${body}\n\n${sig}`;
}