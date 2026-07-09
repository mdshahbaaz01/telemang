export type MessageFormat = "plain" | "mono" | "quote" | "html";

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
): FormattedMessage {
  if (format === "mono") {
    return { message: `<code>${htmlEscape(message)}</code>`, parseMode: "html" };
  }
  if (format === "quote") {
    return { message: `<blockquote>${htmlEscape(message)}</blockquote>`, parseMode: "html" };
  }
  if (format === "html" || hasTelegramHtmlTags(message)) {
    return { message, parseMode: "html" };
  }
  return { message };
}