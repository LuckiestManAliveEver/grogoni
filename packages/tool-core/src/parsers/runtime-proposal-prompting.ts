import type { RuntimeToolName } from "../contracts/runtime.js";

/** Canonical structured-output contract shared by server and on-device model adapters. */
export function renderRuntimeModelOutputInstructions(
  allowedTools: readonly RuntimeToolName[]
): string {
  const tools = [...new Set(allowedTools)].join(", ");
  return [
    "Return only one JSON object. Do not include markdown or surrounding commentary.",
    'Allowed shapes: {"type":"tool","toolName":"products.list","input":{},"reason":"..."}',
    'or {"type":"clarification","message":"..."}',
    'or {"type":"response","message":"..."}.',
    `Allowed tools: ${tools || "none"}.`,
    "A tool proposal is only a request; the Grogoni server validates permissions and confirmation before execution."
  ].join("\n");
}

interface RuntimeModelFewShotExample {
  /** null = not gated by allowedTools (a clarification/response example, not a tool call). */
  toolName: RuntimeToolName | null;
  message: string;
  output: string;
}

const runtimeModelFewShotExamples: readonly RuntimeModelFewShotExample[] = [
  {
    toolName: "products.list",
    message: "show me my products",
    output:
      '{"type":"tool","toolName":"products.list","input":{},"reason":"List products for the active business."}'
  },
  {
    toolName: "product.create",
    message: "add sugar 10kg at 150 shillings",
    output:
      '{"type":"tool","toolName":"product.create","input":{"name":"Sugar","unit":"kg","quantity":10,"sellingPrice":150},"reason":"Draft a new product from the merchant message."}'
  },
  {
    toolName: "customer.update",
    message: "update Mary's phone to 0712345678",
    output:
      '{"type":"tool","toolName":"customer.update","input":{"customerName":"Mary","phone":"0712345678"},"reason":"Draft an update to the existing customer record."}'
  },
  {
    toolName: null,
    message: "add a new product",
    output: '{"type":"clarification","message":"What is the product name?"}'
  },
  {
    toolName: null,
    message: "can you file my tax returns with KRA",
    output:
      '{"type":"response","message":"I can\'t file taxes with KRA directly, but I can help track your tax records in-app."}'
  }
];

/**
 * Worked <input, output> examples for the model's structured-output contract - GPT-3 and
 * Chain-of-Thought's shared finding that a handful of in-context demonstrations measurably
 * improves structured-output correctness over an instruction alone. Only shown alongside
 * renderRuntimeModelOutputInstructions, whose contract these examples demonstrate; filtered to
 * the tools actually allowed for this request so an example never references a tool the model
 * isn't permitted to call. Deliberately small and fixed (not learned/optimized) - this is meant
 * as a light, cheap correctness aid, not a prompt-optimization pipeline.
 */
export function renderRuntimeModelFewShotExamples(
  allowedTools: readonly RuntimeToolName[]
): string {
  const allowed = new Set(allowedTools);
  const applicable = runtimeModelFewShotExamples.filter(
    (example) => example.toolName === null || allowed.has(example.toolName)
  );
  if (applicable.length === 0) return "";
  const rendered = applicable
    .map((example) => `Merchant: "${example.message}"\nYou: ${example.output}`)
    .join("\n\n");
  return `Worked examples of the exact output format (do not copy their content, only their shape):\n\n${rendered}`;
}
