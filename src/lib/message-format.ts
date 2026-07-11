export type MessageFormat = "plain" | "mono" | "quote" | "html";

import { renderSpintax, appendSignature, type SpintaxVars } from "./spintax";
export type { SpintaxVars } from "./spintax";

export function htmlEscape(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function hasTelegramHtmlTags(message: string): boolean {
  return /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|a)(?:\s+[^>]*)?>/i.test(
    message,
  );
}

export interface FormattedMessage {
  message: string;
  parseMode?: "html";
}

export function formatMessage(
  message: string,
  format?: MessageFormat,
  opts?: { vars?: SpintaxVars; signature?: string | null },
): FormattedMessage {
  const withSig = appendSignature(message, opts?.signature ?? null);
  const rendered = renderSpintax(withSig, opts?.vars);
  if (format === "mono") {
    return { message: `<code>${htmlEscape(rendered)}</code>`, parseMode: "html" };
  }
  if (format === "quote") {
    return { message: `<blockquote>${htmlEscape(rendered)}</blockquote>`, parseMode: "html" };
  }
  if (format === "html" || hasTelegramHtmlTags(rendered)) {
    return { message: rendered, parseMode: "html" };
  }
  return { message: rendered };
}