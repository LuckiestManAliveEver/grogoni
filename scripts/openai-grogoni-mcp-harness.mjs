import { randomUUID } from "node:crypto";

export const expectedReadTools = [
  "grogoni.list_shops",
  "grogoni.get_sync_changes",
  "grogoni.query_catalogue"
];

export const expectedActionTools = ["grogoni.runtime_turn", "grogoni.confirm_runtime_action"];

export class HarnessError extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.name = "HarnessError";
    this.category = category;
    this.details = details;
  }
}

export function loadHarnessConfig(env = process.env) {
  const requiredNames = ["OPENAI_API_KEY", "GROGONI_MCP_SERVER_URL", "GROGONI_MCP_TOKEN", "GROGONI_SHOP_ID"];
  const missing = requiredNames.filter((name) => clean(env[name]) === "");
  if (missing.length > 0) {
    throw new HarnessError(
      "configuration",
      `Missing required environment variables: ${missing.join(", ")}`,
      { missing }
    );
  }

  const serverUrl = parseServerUrl(clean(env.GROGONI_MCP_SERVER_URL));
  const shopId = clean(env.GROGONI_SHOP_ID);
  if (serverUrl.searchParams.get("shopId") !== shopId) {
    throw new HarnessError(
      "configuration",
      "GROGONI_MCP_SERVER_URL must contain a shopId query parameter matching GROGONI_SHOP_ID."
    );
  }

  return {
    apiKey: clean(env.OPENAI_API_KEY),
    serverUrl: serverUrl.toString(),
    token: clean(env.GROGONI_MCP_TOKEN),
    shopId,
    model: clean(env.OPENAI_MCP_TEST_MODEL) || clean(env.OPENAI_FAST_MODEL) || "gpt-5-mini",
    readToken: optional(env.GROGONI_MCP_READ_TOKEN),
    revokedToken: optional(env.GROGONI_MCP_REVOKED_TOKEN),
    allowMutations: clean(env.GROGONI_MCP_ALLOW_MUTATIONS) === "true",
    dedicatedTestShop: clean(env.GROGONI_MCP_DEDICATED_TEST_SHOP) === "true",
    waitForSessionRotation: clean(env.GROGONI_MCP_WAIT_FOR_SESSION_ROTATION) === "true",
    timeoutMs: positiveInteger(env.OPENAI_MCP_TEST_TIMEOUT_MS, 90_000)
  };
}

export function makeMcpTool(config, overrides = {}) {
  return {
    type: "mcp",
    server_label: "grogoni_shop",
    server_description:
      "Shop-scoped Grogoni catalogue and governed business runtime. Mutations require confirmation.",
    server_url: overrides.serverUrl ?? config.serverUrl,
    authorization: overrides.token ?? config.token,
    require_approval: "always"
  };
}

export function forcedMcpToolChoice(name) {
  return { type: "mcp", server_label: "grogoni_shop", name };
}

export function outputItems(response, type) {
  return Array.isArray(response?.output)
    ? response.output.filter((item) => isRecord(item) && item.type === type)
    : [];
}

export function discoveredToolNames(response) {
  const names = [];
  for (const item of outputItems(response, "mcp_list_tools")) {
    if (!Array.isArray(item.tools)) continue;
    for (const tool of item.tools) {
      if (isRecord(tool) && typeof tool.name === "string") names.push(tool.name);
    }
  }
  return [...new Set(names)].sort();
}

export function responseText(response) {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  const text = [];
  if (!Array.isArray(response?.output)) return "";
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        text.push(content.text);
      }
    }
  }
  return text.join("").trim();
}

export function parseMcpCall(call) {
  if (!isRecord(call) || call.type !== "mcp_call") {
    throw new HarnessError("tool_execution", "Expected an mcp_call output item.");
  }
  const parsed = parseJson(call.output);
  const envelope = isRecord(parsed) ? parsed : {};
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const contentValue = parseTextContent(content);
  const hasStructuredContent = Object.hasOwn(envelope, "structuredContent");
  const structuredContent = hasStructuredContent
    ? envelope.structuredContent
    : (contentValue ?? (parsed === null ? null : parsed));
  return {
    name: typeof call.name === "string" ? call.name : "unknown",
    status: typeof call.status === "string" ? call.status : "unknown",
    error: typeof call.error === "string" ? call.error : null,
    isError:
      envelope.isError === true || typeof call.error === "string" || call.status === "failed",
    content,
    hasContent: content.length > 0,
    hasStructuredContent,
    structuredContent,
    rawEnvelope: parsed
  };
}

export function catalogueProducts(call) {
  const parsed = parseMcpCall(call);
  const value = parsed.structuredContent;
  if (!isRecord(value) || !Array.isArray(value.products)) {
    throw new HarnessError("tool_execution", "Catalogue tool output did not contain products[].", {
      toolName: parsed.name,
      status: parsed.status
    });
  }
  return { parsed, products: value.products };
}

export function runtimeState(call) {
  const parsed = parseMcpCall(call);
  const value = parsed.structuredContent;
  if (!isRecord(value) || !isRecord(value.turn)) {
    throw new HarnessError("tool_execution", "Runtime tool output did not contain a turn.");
  }
  const turn = value.turn;
  const session = isRecord(value.session) ? value.session : {};
  const plan = isRecord(turn.plan) ? turn.plan : {};
  return {
    parsed,
    status: typeof turn.status === "string" ? turn.status : "unknown",
    runtimeSessionId: typeof session.id === "string" ? session.id : null,
    confirmationToken: typeof plan.confirmationToken === "string" ? plan.confirmationToken : null,
    toolName: typeof plan.toolName === "string" ? plan.toolName : null
  };
}

export function parseModelJson(text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  return parseJson(unfenced);
}

export function makeRedactor(secrets) {
  const values = [
    ...new Set(secrets.filter((value) => typeof value === "string" && value !== ""))
  ].sort((left, right) => right.length - left.length);
  return (input) => {
    let output = String(input);
    for (const value of values) output = output.split(value).join("[REDACTED]");
    return output
      .replace(/grogoni_mcp_[A-Za-z0-9._~-]+/gu, "grogoni_mcp_[REDACTED]")
      .replace(/Authorization:\s*Bearer\s+\S+/giu, "Authorization: Bearer [REDACTED]");
  };
}

export function assertNoSecretLeak(output, secrets) {
  for (const secret of secrets) {
    if (typeof secret === "string" && secret !== "" && output.includes(secret)) {
      throw new HarnessError("secret_leak", "Verification report contained a configured secret.");
    }
  }
  if (/Authorization:\s*Bearer\s+(?!\[REDACTED\])\S+/iu.test(output)) {
    throw new HarnessError("secret_leak", "Verification report contained an Authorization header.");
  }
}

export function replaceShopId(serverUrl, shopId) {
  const url = new globalThis.URL(serverUrl);
  url.searchParams.set("shopId", shopId);
  return url.toString();
}

export function invalidMcpUrl(serverUrl) {
  const url = new globalThis.URL(serverUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/__openai_mcp_verification_missing__`;
  return url.toString();
}

export function safeError(error, redact = (value) => String(value)) {
  if (error instanceof HarnessError) {
    return {
      category: error.category,
      message: redact(error.message),
      details: redact(JSON.stringify(error.details))
    };
  }
  return {
    category: "unexpected",
    message: redact(error instanceof Error ? error.message : String(error)),
    details: "{}"
  };
}

export function uuid() {
  return randomUUID();
}

function parseServerUrl(value) {
  let url;
  try {
    url = new globalThis.URL(value);
  } catch {
    throw new HarnessError("configuration", "GROGONI_MCP_SERVER_URL must be a valid URL.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new HarnessError(
      "configuration",
      "GROGONI_MCP_SERVER_URL must use HTTPS unless it targets localhost."
    );
  }
  return url;
}

function parseTextContent(content) {
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    const value = parseJson(item.text);
    if (value !== null) return value;
  }
  return null;
}

function parseJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optional(value) {
  const normalized = clean(value);
  return normalized === "" ? null : normalized;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
