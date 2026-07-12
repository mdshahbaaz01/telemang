import type { ButtonChoiceRequest, MathSolveRequest, SolveResult, ImageSolveRequest } from "./types";

// AI-powered solvers for text-form puzzles and multi-choice image buttons.
// Uses the Lovable AI Gateway (gemini-2.5-flash) for vision + reasoning.
// No user API key needed — LOVABLE_API_KEY is auto-provisioned server-side.

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL_VISION = "google/gemini-2.5-flash";

function key(): string {
  const k = process.env.LOVABLE_API_KEY;
  if (!k) throw new Error("LOVABLE_API_KEY not configured");
  return k;
}

async function chat(messages: Array<Record<string, unknown>>, opts?: { jsonSchema?: Record<string, unknown> }): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL_VISION,
    messages,
    temperature: 0,
  };
  if (opts?.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "answer", strict: true, schema: opts.jsonSchema },
    };
  }
  const r = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`ai-vision (${r.status}): ${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = j.choices?.[0]?.message?.content ?? "";
  return content.trim();
}

export async function solveMathAi(req: MathSolveRequest): Promise<SolveResult> {
  const t0 = Date.now();
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text:
        "You are a captcha solver. Solve the puzzle in the input. " +
        "Return ONLY the final answer, no words, no punctuation. " +
        "For math give a number. For 'type the Nth word' give just the word.",
    },
  ];
  if (req.text) content.push({ type: "text", text: `Puzzle: ${req.text}` });
  if (req.imageBase64) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${req.imageBase64}` },
    });
  }
  const answer = await chat([{ role: "user", content }]);
  return { success: true, provider: "ai-vision", answer: answer.replace(/[\s"'`.]+$/g, "").slice(0, 60), latencyMs: Date.now() - t0 };
}

export async function solveButtonChoiceAi(req: ButtonChoiceRequest): Promise<SolveResult> {
  const t0 = Date.now();
  const parts: Array<Record<string, unknown>> = [
    {
      type: "text",
      text:
        `Choose ONE button that best matches: "${req.prompt}". ` +
        `Reply with the 0-based index only. Buttons follow below in order.`,
    },
  ];
  req.choices.forEach((c, i) => {
    parts.push({ type: "text", text: `[${i}] ${c.label}${c.text ? ` — ${c.text}` : ""}` });
    if (c.imageBase64) {
      parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${c.imageBase64}` } });
    }
  });
  const answer = await chat([{ role: "user", content: parts }], {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: { index: { type: "integer", minimum: 0, maximum: req.choices.length - 1 } },
    },
  });
  let idx = 0;
  try {
    idx = Number(JSON.parse(answer).index) || 0;
  } catch {
    const m = answer.match(/\d+/);
    idx = m ? Number(m[0]) : 0;
  }
  idx = Math.max(0, Math.min(req.choices.length - 1, idx));
  return {
    success: true,
    provider: "ai-vision",
    answer: String(idx),
    choiceIndex: idx,
    latencyMs: Date.now() - t0,
  };
}

// Fallback image OCR via AI when no external solver is configured.
export async function solveImageAi(req: ImageSolveRequest): Promise<SolveResult> {
  const t0 = Date.now();
  const instructions: string[] = [
    "Read the captcha text in this image. Reply with ONLY the characters, no spaces, no extra words.",
  ];
  if (req.numeric) instructions.push("It contains only digits.");
  if (req.minLength || req.maxLength) instructions.push(`Length ${req.minLength ?? "?"}-${req.maxLength ?? "?"}.`);
  if (req.caseSensitive) instructions.push("Preserve exact case.");
  if (req.hint) instructions.push(`Hint: ${req.hint}`);
  const answer = await chat([
    {
      role: "user",
      content: [
        { type: "text", text: instructions.join(" ") },
        { type: "image_url", image_url: { url: `data:image/png;base64,${req.imageBase64}` } },
      ],
    },
  ]);
  return {
    success: true,
    provider: "ai-vision",
    answer: answer.replace(/[\s"'`]/g, "").slice(0, 80),
    latencyMs: Date.now() - t0,
  };
}