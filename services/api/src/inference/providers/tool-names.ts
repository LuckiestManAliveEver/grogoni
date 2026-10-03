/**
 * Grogoni tool names contain dots ("products.list"); OpenAI and Anthropic function names must match
 * ^[a-zA-Z0-9_-]{1,64}$. Adapters encode on the way out and decode on the way back so the rest of
 * Grogoni only ever sees canonical names. The encoding is reversible and collision-free for the
 * registry's actual names (dots -> "__", and no registry name contains "__").
 */
export function encodeToolName(name: string): string {
  return name.replaceAll(".", "__");
}

export function decodeToolName(wireName: string): string {
  return wireName.replaceAll("__", ".");
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
