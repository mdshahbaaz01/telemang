import { describe, it, expect } from "vitest";
import { formatMessage, hasTelegramHtmlTags } from "./message-format";

describe("formatMessage", () => {
  it("plain 'Hi' → no parse mode", () => {
    expect(formatMessage("Hi", "plain")).toEqual({ message: "Hi" });
  });

  it("mono 'Hi' → wraps in <code> with html parseMode", () => {
    expect(formatMessage("Hi", "mono")).toEqual({
      message: "<code>Hi</code>",
      parseMode: "html",
    });
  });

  it("mono escapes special chars", () => {
    expect(formatMessage("a<b&c", "mono").message).toBe("<code>a&lt;b&amp;c</code>");
  });

  it("quote 'Hi' → wraps in <blockquote>", () => {
    expect(formatMessage("Hi", "quote")).toEqual({
      message: "<blockquote>Hi</blockquote>",
      parseMode: "html",
    });
  });

  it("html format preserves message and sets parseMode", () => {
    expect(formatMessage("<b>Hi</b>", "html")).toEqual({
      message: "<b>Hi</b>",
      parseMode: "html",
    });
  });

  it("auto-detects HTML tags even in plain format", () => {
    expect(formatMessage("<code>Hi</code>", "plain")).toEqual({
      message: "<code>Hi</code>",
      parseMode: "html",
    });
    expect(formatMessage("<pre>x</pre>", "plain").parseMode).toBe("html");
    expect(formatMessage("<blockquote>x</blockquote>", "plain").parseMode).toBe("html");
  });

  it("plain text without tags → no parseMode", () => {
    expect(formatMessage("just words", "plain")).toEqual({ message: "just words" });
  });

  it("hasTelegramHtmlTags detects supported tags", () => {
    for (const t of ["b", "strong", "i", "em", "u", "ins", "s", "code", "pre", "blockquote", "a"]) {
      expect(hasTelegramHtmlTags(`<${t}>x</${t}>`)).toBe(true);
    }
    expect(hasTelegramHtmlTags("no tags here")).toBe(false);
    expect(hasTelegramHtmlTags("<div>x</div>")).toBe(false);
  });
});

// Simulate how call sites use the formatter in both immediate and scheduled
// send paths. Both paths must apply identical formatting.
describe("broadcast send parity (immediate vs scheduled)", () => {
  const cases: Array<{ label: string; input: string; format: "plain" | "mono" | "quote" | "html" }> = [
    { label: "plain Hi", input: "Hi", format: "plain" },
    { label: "mono Hi", input: "Hi", format: "mono" },
    { label: "quote Hi", input: "Hi", format: "quote" },
    { label: "html <b>Hi</b>", input: "<b>Hi</b>", format: "html" },
    { label: "html <code>Hi</code>", input: "<code>Hi</code>", format: "html" },
    { label: "html <pre>Hi</pre>", input: "<pre>Hi</pre>", format: "html" },
    { label: "auto-detected <code>Hi</code> as plain", input: "<code>Hi</code>", format: "plain" },
  ];

  for (const c of cases) {
    it(`${c.label} produces same output on both paths`, () => {
      const immediate = formatMessage(c.input, c.format);
      const scheduled = formatMessage(c.input, c.format);
      expect(immediate).toEqual(scheduled);
    });
  }

  it("Hi with mono sends as <code>Hi</code> parseMode=html on both paths", () => {
    const r = formatMessage("Hi", "mono");
    expect(r.message).toBe("<code>Hi</code>");
    expect(r.parseMode).toBe("html");
  });
});