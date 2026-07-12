// Sprinkle emojis into text at word boundaries. Density = probability per word (0-1).
const DEFAULT_EMOJIS = ["🔥", "✨", "💯", "🚀", "🎉", "👀", "👍", "💥", "❤️", "😎", "⚡", "🌟"];

export function sprinkleEmojis(text: string, density = 0.15, emojis: string[] = DEFAULT_EMOJIS): string {
  if (!text.trim()) return text;
  const d = Math.max(0, Math.min(1, density));
  const pick = () => emojis[Math.floor(Math.random() * emojis.length)];
  // Split preserving whitespace tokens
  return text.replace(/(\s+|$)/g, (ws) => {
    if (!ws) return ws;
    if (Math.random() < d) return ` ${pick()}${ws}`;
    return ws;
  });
}

export const EMOJI_PRESETS: Record<string, string[]> = {
  hype: ["🔥", "🚀", "💯", "⚡", "💥"],
  love: ["❤️", "💖", "😍", "🥰", "💕"],
  funny: ["😂", "🤣", "😆", "🙃", "😜"],
  cool: ["😎", "🕶️", "🧊", "✨", "🌟"],
  crypto: ["💰", "🪙", "📈", "🚀", "💎"],
};
