/** Both the native worker's agent envelope and the Edge lane's public task result. */
export function daemonResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  if ("text" in result && typeof result.text === "string") return result.text;
  const completion = (result as { completion?: { outputText?: unknown } }).completion;
  const raw = typeof completion?.outputText === "string" ? completion.outputText : "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    /* Plain output is supported by the existing runtime. */
  }
  return raw;
}
