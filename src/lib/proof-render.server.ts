import { initWasm, Resvg } from "@resvg/resvg-wasm";

export { buildChannelViewSvg, buildChatListSvg } from "./proof-render";
export type { ChannelInfo, OtherDialog, ChannelMessage } from "./proof-render";

const WASM_URL = "https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm";

let wasmReady: Promise<void> | null = null;
async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`Failed to fetch resvg wasm: ${res.status}`);
      const buf = await res.arrayBuffer();
      await initWasm(buf);
    })().catch((e) => {
      wasmReady = null;
      throw e;
    });
  }
  return wasmReady;
}

export async function renderSvgToPng(svg: string): Promise<Buffer> {
  await ensureWasm();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 720 },
    font: { loadSystemFonts: false, defaultFontFamily: "Helvetica" },
  });
  const png = resvg.render();
  const bytes = png.asPng();
  return Buffer.from(bytes);
}