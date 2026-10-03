import type { RuntimeToolDefinition, RuntimeToolName } from "../contracts/runtime.js";

export const workspaceRuntimeTools = {
  "workspace.deliver": {
    name: "workspace.deliver",
    hub: null,
    description:
      "Deliver a file from the active business workspace into the current Grogoni conversation. Use this instead of exposing a filesystem path.",
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "business:read",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          required: true,
          description: "Path to a file inside the active workspace."
        },
        additionalPaths: {
          type: "array",
          description: "Optional additional workspace file paths to deliver in the same message."
        },
        caption: {
          type: "string",
          description: "Optional short caption shown with the delivered file."
        }
      }
    },
    mcpExposable: false
  }
} satisfies Partial<Record<RuntimeToolName, RuntimeToolDefinition>>;
