const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function isBubble(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const bubble = value as Record<string, unknown>;
  if (bubble.type !== "bubble" || byteLength(bubble) > 30_000) return false;
  const blocks = [bubble.header, bubble.hero, bubble.body, bubble.footer].filter(Boolean);
  return blocks.length > 0 && blocks.every((block) => typeof block === "object");
}

export function validFlexContainer(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const container = value as Record<string, unknown>;
  if (container.type === "bubble") return isBubble(container);
  if (container.type !== "carousel" || byteLength(container) > 50_000 || !Array.isArray(container.contents)) return false;
  return container.contents.length >= 1 && container.contents.length <= 12 && container.contents.every(isBubble);
}

