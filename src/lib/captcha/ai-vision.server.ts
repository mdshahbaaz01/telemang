import type {
  ButtonChoiceRequest,
  MathSolveRequest,
  SolveResult,
  ImageSolveRequest,
  ImagePlusRequest,
} from "./types";

// AI-powered captcha solvers. No user API key required — LOVABLE_API_KEY is
// auto-provisioned. Uses Gemini 2.5 Flash for fast tasks and Gemini 2.5 Pro
// for hard visual reasoning (grid / coordinates / rotate / audio).

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL_FAST = "google/gemini-2.5-flash";
const MODEL_PRO = "google/gemini-2.5-pro";

function key(): string {
  const k = process.env.LOVABLE_API_KEY;
  if (!k) throw new Error("LOVABLE_API_KEY not configured");
  return k;
}

async function chat(
  messages: Array<Record<string, unknown>>,
  opts?: { jsonSchema?: Record<string, unknown>; model?: string },
): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts?.model ?? MODEL_FAST,
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

// --- Advanced visual puzzles (Pro model for accuracy) ------------------------

/** Grid puzzle: "click all squares with traffic lights". Returns "1,3,5" of matching cells. */
export async function solveGridAi(req: ImagePlusRequest): Promise<SolveResult> {
  const t0 = Date.now();
  const rows = Number(req.extra?.rows ?? 3);
  const cols = Number(req.extra?.cols ?? 3);
  const prompt = req.hint || "Select all matching cells.";
  const raw = await chat(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `This is a ${rows}x${cols} grid captcha (numbered left→right, top→bottom starting at 1). ` +
              `Task: ${prompt}. Return the numbers of ALL cells that match, as JSON {"cells":[1,3,...]}.`,
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${req.imageBase64}` } },
        ],
      },
    ],
    {
      model: MODEL_PRO,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["cells"],
        properties: { cells: { type: "array", items: { type: "integer", minimum: 1 } } },
      },
    },
  );
  let cells: number[] = [];
  try {
    cells = (JSON.parse(raw).cells as number[]).filter((n) => n >= 1 && n <= rows * cols);
  } catch {
    cells = raw.match(/\d+/g)?.map(Number).filter((n) => n >= 1 && n <= rows * cols) ?? [];
  }
  return { success: true, provider: "ai-vision-pro", answer: cells.join(","), latencyMs: Date.now() - t0 };
}

/** Click coordinates: return "x=W,y=H" of the point to click, using absolute pixels. */
export async function solveCoordinatesAi(req: ImagePlusRequest): Promise<SolveResult> {
  const t0 = Date.now();
  const prompt = req.hint || "Click the correct object.";
  const raw = await chat(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Captcha instruction: ${prompt}. Reply strictly as JSON {"x":<pixels_from_left>,"y":<pixels_from_top>}. ` +
              `Use the image's own pixel dimensions.`,
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${req.imageBase64}` } },
        ],
      },
    ],
    {
      model: MODEL_PRO,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: { x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 } },
      },
    },
  );
  let x = 0, y = 0;
  try { const j = JSON.parse(raw); x = Number(j.x) || 0; y = Number(j.y) || 0; } catch { /* ignore */ }
  return { success: true, provider: "ai-vision-pro", answer: `${x},${y}`, latencyMs: Date.now() - t0 };
}

/** Rotate: return the angle (0..359) the image must be rotated clockwise to be upright. */
export async function solveRotateAi(req: ImagePlusRequest): Promise<SolveResult> {
  const t0 = Date.now();
  const raw = await chat(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "This image is rotated. Reply with the integer degrees (0-359) it must rotate CLOCKWISE to be upright. " +
              'JSON only: {"angle":N}.',
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${req.imageBase64}` } },
        ],
      },
    ],
    {
      model: MODEL_PRO,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["angle"],
        properties: { angle: { type: "integer", minimum: 0, maximum: 359 } },
      },
    },
  );
  let angle = 0;
  try { angle = Number(JSON.parse(raw).angle) || 0; } catch { /* ignore */ }
  return { success: true, provider: "ai-vision-pro", answer: String(angle % 360), latencyMs: Date.now() - t0 };
}

/** Audio captcha: transcribe an audio clip to the spoken characters/digits. */
export async function solveAudioAi(req: ImagePlusRequest): Promise<SolveResult> {
  const t0 = Date.now();
  const fmt = (req.extra?.format as string) || "mp3";
  const answer = await chat(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Transcribe the spoken captcha in this audio. Reply with ONLY the characters/digits, " +
              "no spaces, no punctuation, no explanation.",
          },
          { type: "input_audio", input_audio: { data: req.imageBase64, format: fmt } },
        ],
      },
    ],
    { model: MODEL_PRO },
  );
  return {
    success: true,
    provider: "ai-vision-pro",
    answer: answer.replace(/[\s"'`.,-]/g, "").slice(0, 80),
    latencyMs: Date.now() - t0,
  };
}