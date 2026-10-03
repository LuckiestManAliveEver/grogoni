import { useEffect, useState } from "react";

import type {
  McpAccessScope,
  McpAccessTokenCreated,
  McpAccessTokenSummary
} from "@grogoni/shared-types";

import { deleteJson, getJson, postJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";
import { formatDate } from "./formatters";
import { readApiBaseUrl } from "./lib/api";

const modelLabOptions = [
  { id: "business_system", label: "Existing business system" },
  { id: "external_agent", label: "External agent app" },
  { id: "openai", label: "OpenAI API" },
  { id: "anthropic", label: "Anthropic API" },
  { id: "google", label: "Gemini API" },
  { id: "other", label: "Another MCP client" }
] as const;

type ModelLabId = (typeof modelLabOptions)[number]["id"];

function modelLabSetup(
  modelLabId: ModelLabId,
  shopConnectionUrl: string,
  accessToken: string
): { configuration: string; instructions: string } {
  if (modelLabId === "business_system") {
    const apiBaseUrl = shopConnectionUrl.replace(/\/mcp\?shopId=.*$/u, "/v1/shop-system");
    return {
      instructions:
        "Use the token as a Bearer credential. PUT catalogue updates, GET incoming Grogoni Chat orders, and PATCH order status after your system accepts or fulfils them.",
      configuration: JSON.stringify(
        {
          catalogue: { method: "PUT", url: `${apiBaseUrl}/catalogue` },
          orders: { method: "GET", url: `${apiBaseUrl}/orders` },
          updateOrder: { method: "PATCH", url: `${apiBaseUrl}/orders/{orderId}` },
          headers: { Authorization: `Bearer ${accessToken}` }
        },
        null,
        2
      )
    };
  }
  if (modelLabId === "external_agent") {
    return {
      instructions:
        "Use this with any MCP-capable agent UI, including Muse, Instinct, ChatGPT, Claude, or another model app. Paste the URL as the remote MCP server and send the Grogoni secret as a Bearer credential. With the permissions you grant, the agent can monitor and send messages, establish end-to-end encrypted agent and model channels, handle shop work, browse the marketplace, and prepare purchases for your confirmation.",
      configuration: JSON.stringify(
        {
          transport: "streamable-http",
          server: {
            name: "grogoni_shop",
            url: shopConnectionUrl,
            headers: { Authorization: `Bearer ${accessToken}` }
          },
          credentials: {
            type: "bearer",
            token: accessToken
          }
        },
        null,
        2
      )
    };
  }
  if (modelLabId === "openai") {
    return {
      instructions:
        "Add this object as an MCP tool in an OpenAI Responses API request. The authorization value is the Grogoni connection secret, not your OpenAI API key.",
      configuration: JSON.stringify(
        {
          type: "mcp",
          server_label: "grogoni_shop",
          server_url: shopConnectionUrl,
          authorization: accessToken,
          require_approval: "always"
        },
        null,
        2
      )
    };
  }
  if (modelLabId === "anthropic") {
    return {
      instructions:
        "Merge these fields into an Anthropic Messages API request. The authorization_token is the Grogoni connection secret, not your Anthropic API key.",
      configuration: JSON.stringify(
        {
          mcp_servers: [
            {
              type: "url",
              name: "grogoni_shop",
              url: shopConnectionUrl,
              authorization_token: accessToken
            }
          ],
          tools: [{ type: "mcp_toolset", mcp_server_name: "grogoni_shop" }],
          betas: ["mcp-client-2025-11-20"]
        },
        null,
        2
      )
    };
  }
  if (modelLabId === "google") {
    return {
      instructions:
        "Add this object to tools in a Gemini Interactions API request. Keep your Gemini API key separate from the Grogoni Authorization header.",
      configuration: JSON.stringify(
        {
          type: "mcp_server",
          name: "grogoni_shop",
          url: shopConnectionUrl,
          headers: { Authorization: `Bearer ${accessToken}` }
        },
        null,
        2
      )
    };
  }
  return {
    instructions:
      "Add a remote Streamable HTTP MCP server with this URL and send the Grogoni secret in its Authorization header.",
    configuration: JSON.stringify(
      {
        url: shopConnectionUrl,
        headers: { Authorization: `Bearer ${accessToken}` }
      },
      null,
      2
    )
  };
}

export interface McpAccessTokensPanelProps {
  accountId: string;
  businessId: string;
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  setProfileMessage: (message: string) => void;
  copyStorefrontValue: (value: string, label: string) => Promise<void>;
}

export function McpAccessTokensPanel({
  accountId,
  businessId,
  pendingProfileAction,
  runProfileAction,
  setProfileMessage,
  copyStorefrontValue
}: McpAccessTokensPanelProps) {
  const [mcpTokens, setMcpTokens] = useState<McpAccessTokenSummary[]>([]);
  const [modelLabId, setModelLabId] = useState<ModelLabId>("external_agent");
  const [mcpTokenName, setMcpTokenName] = useState("External agent shop connection");
  const [mcpReadEnabled, setMcpReadEnabled] = useState(true);
  const [mcpActEnabled, setMcpActEnabled] = useState(false);
  const [mcpPin, setMcpPin] = useState("");
  const [newMcpAccessToken, setNewMcpAccessToken] = useState("");
  const [newMcpAccessScopes, setNewMcpAccessScopes] = useState<McpAccessScope[]>([]);
  const shopConnectionUrl = `${readApiBaseUrl()}/mcp?shopId=${encodeURIComponent(businessId)}`;

  function selectModelLab(nextModelLabId: ModelLabId) {
    setModelLabId(nextModelLabId);
    const selected = modelLabOptions.find((option) => option.id === nextModelLabId);
    setMcpTokenName(`${selected?.label ?? "External agent"} shop connection`);
    setNewMcpAccessToken("");
    setNewMcpAccessScopes([]);
  }

  async function loadMcpTokens() {
    try {
      const response = await getJson<{ tokens: McpAccessTokenSummary[] }>("/v1/mcp/tokens");
      setMcpTokens(response.tokens);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function createMcpToken() {
    const scopes: McpAccessScope[] = [
      ...(mcpReadEnabled ? (["mcp:read"] as const) : []),
      ...(mcpActEnabled ? (["mcp:act"] as const) : [])
    ];
    if (scopes.length === 0) {
      setProfileMessage("Select at least one MCP permission.");
      return;
    }
    try {
      if (mcpActEnabled) {
        await postJson<{ verified: boolean }>("/auth/pin/verify", { pin: mcpPin });
      }
      const created = await postJson<McpAccessTokenCreated>("/v1/mcp/tokens", {
        name: mcpTokenName,
        scopes,
        shopId: businessId,
        expiresInSeconds: 2_592_000
      });
      setNewMcpAccessToken(created.accessToken);
      setNewMcpAccessScopes(created.token.scopes);
      setMcpPin("");
      await loadMcpTokens();
      setProfileMessage(
        "External agent shop connection created. Copy its API configuration into your agent app."
      );
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function revokeMcpToken(tokenId: string) {
    try {
      await deleteJson<McpAccessTokenSummary>(`/v1/mcp/tokens/${encodeURIComponent(tokenId)}`);
      await loadMcpTokens();
      setProfileMessage("MCP token revoked.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  useEffect(() => {
    void loadMcpTokens();
  }, [accountId, businessId]);

  const selectedModelLab =
    modelLabOptions.find((option) => option.id === modelLabId) ?? modelLabOptions[0];
  const selectedModelLabSetup = modelLabSetup(modelLabId, shopConnectionUrl, newMcpAccessToken);
  const connectionBundle = [
    `Grogoni shop: ${businessId}`,
    `Provider: ${selectedModelLab.label}`,
    `Permissions: ${[
      ...(newMcpAccessScopes.includes("mcp:read") ? ["read shop data"] : []),
      ...(newMcpAccessScopes.includes("mcp:act") ? ["propose confirmed actions"] : [])
    ].join(", ")}`,
    "",
    selectedModelLabSetup.configuration
  ].join("\n");

  return (
    <div className="record-form cloud-model-connection">
      <div className="section-heading">
        <p className="eyebrow">Shop API</p>
        <h4>Connect an external agent</h4>
        <p>
          Create a shop-bound API connection for any external MCP-capable agent UI or commerce
          system that has the credentials you grant here. Muse, Instinct, ChatGPT, Claude, and other
          model apps all use the same URL and bearer secret. They can act as a message inbox, send
          replies, communicate with other agents and models over encrypted channels, handle
          permitted shop work, and help buyers browse and shop with confirmation.
        </p>
      </div>
      <div className="model-lab-grid" aria-label="Supported external agent connections">
        {modelLabOptions.map((option) => (
          <button
            className={modelLabId === option.id ? "selected" : "secondary"}
            type="button"
            aria-pressed={modelLabId === option.id}
            key={option.id}
            onClick={() => selectModelLab(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <label>
        Connection name
        <input value={mcpTokenName} onChange={(event) => setMcpTokenName(event.target.value)} />
      </label>
      <div className="checkbox-list">
        <label>
          <input
            type="checkbox"
            checked={mcpReadEnabled}
            onChange={(event) => setMcpReadEnabled(event.target.checked)}
          />
          Let the connected system read shop data and incoming orders
        </label>
        <label>
          <input
            type="checkbox"
            checked={mcpActEnabled}
            onChange={(event) => setMcpActEnabled(event.target.checked)}
          />
          Let the connected system sync catalogue changes and update order status
        </label>
      </div>
      {mcpActEnabled ? (
        <label>
          Owner PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            value={mcpPin}
            onChange={(event) => setMcpPin(event.target.value)}
            placeholder="Required for action access"
          />
        </label>
      ) : null}
      <button
        type="button"
        disabled={
          pendingProfileAction !== null ||
          mcpTokenName.trim().length < 3 ||
          (mcpActEnabled && !/^\d{4}$/.test(mcpPin))
        }
        onClick={() => void runProfileAction("mcp-create", createMcpToken)}
      >
        Create 30-day API connection
      </button>
      {newMcpAccessToken.length > 0 ? (
        <div className="model-lab-connection-card" role="status">
          <strong>{selectedModelLab.label} connection details</strong>
          <p>{selectedModelLabSetup.instructions} The secret is shown only once.</p>
          <span>Shop API link</span>
          <code>{shopConnectionUrl}</code>
          <div className="ai-model-card-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => void copyStorefrontValue(shopConnectionUrl, "Shop API link")}
            >
              Copy shop link
            </button>
          </div>
          <span>30-day connection secret — shown only once</span>
          <code>{newMcpAccessToken}</code>
          <span>{selectedModelLab.label} API configuration</span>
          <pre>
            <code>{selectedModelLabSetup.configuration}</code>
          </pre>
          <div className="ai-model-card-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => void copyStorefrontValue(newMcpAccessToken, "Connection secret")}
            >
              Copy secret
            </button>
            <button
              type="button"
              onClick={() => void copyStorefrontValue(connectionBundle, "API configuration")}
            >
              Copy API configuration
            </button>
          </div>
        </div>
      ) : null}
      <div className="connected-social-list" aria-label="External agent shop connections">
        {mcpTokens.length === 0 ? (
          <p className="shell-note">No external agent connections yet.</p>
        ) : null}
        {mcpTokens.map((token) => (
          <article className="connected-social-card" key={token.id}>
            <div>
              <span>{token.scopes.join(" · ")}</span>
              <strong>{token.name}</strong>
              <p>
                {token.revokedAt !== null
                  ? "Revoked"
                  : Date.parse(token.expiresAt) <= Date.now()
                    ? "Expired"
                    : `Connected · expires ${formatDate(token.expiresAt)}`}
              </p>
            </div>
            <div className="connected-social-meta">
              <span>Created: {formatDate(token.createdAt)}</span>
              <span>
                Last used: {token.lastUsedAt === null ? "Never" : formatDate(token.lastUsedAt)}
              </span>
            </div>
            <button
              className="secondary"
              type="button"
              disabled={token.revokedAt !== null || pendingProfileAction !== null}
              onClick={() => void runProfileAction("mcp-revoke", () => revokeMcpToken(token.id))}
            >
              Revoke
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
