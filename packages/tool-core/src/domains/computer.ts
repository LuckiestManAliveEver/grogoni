import type { RuntimeToolDefinition, RuntimeToolName } from "../contracts/runtime.js";

const computerInputSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string", description: "Computer session id." },
    profileId: { type: "string", description: "Optional persistent browser profile id." },
    externalSurfaceId: {
      type: "string",
      description: "Provider-neutral id of the authorized external UI surface."
    },
    externalSurfaceType: {
      type: "string",
      description: "External surface type: web, pwa, desktop, or mobile-web."
    },
    externalSurfaceProvider: {
      type: "string",
      description: "Optional external surface provider label for audit metadata."
    },
    approvalId: {
      type: "string",
      description: "One-time approval id for the exact proposed action."
    },
    url: { type: "string", description: "Destination URL for navigation." },
    selector: { type: "string", description: "Provider-neutral element selector or handle." },
    text: { type: "string", description: "Text to type, search for, or use as a target label." },
    fileRef: { type: "string", description: "Trusted file reference for an upload." },
    semanticIntent: {
      type: "string",
      description: "Human-readable intent used by policy and approvals."
    }
  }
} as const;

function computerTool(
  name: RuntimeToolName,
  description: string,
  options: Pick<RuntimeToolDefinition, "risk" | "requiresConfirmation" | "readOnly">
): RuntimeToolDefinition {
  return {
    name,
    // Agent-internal: a merchant never drives the isolated browser from the Shop Hub.
    hub: null,
    description,
    risk: options.risk,
    requiresConfirmation: options.requiresConfirmation,
    readOnly: options.readOnly,
    requiredPermission: "business:write",
    inputSchema: {
      ...computerInputSchema,
      properties: {
        ...computerInputSchema.properties,
        sessionId: {
          ...computerInputSchema.properties.sessionId,
          required: name !== "computer.session.create"
        }
      }
    },
    mcpExposable: false
  };
}

export const computerRuntimeTools = {
  "computer.session.create": computerTool(
    "computer.session.create",
    "Create an isolated provider-backed computer/browser session.",
    { risk: "medium", requiresConfirmation: false, readOnly: false }
  ),
  "computer.session.resume": computerTool(
    "computer.session.resume",
    "Resume an existing isolated computer/browser session.",
    { risk: "medium", requiresConfirmation: false, readOnly: false }
  ),
  "computer.navigate": computerTool("computer.navigate", "Navigate the computer session.", {
    risk: "medium",
    requiresConfirmation: false,
    readOnly: true
  }),
  "computer.observe": computerTool(
    "computer.observe",
    "Observe the current computer session state as untrusted web content.",
    { risk: "low", requiresConfirmation: false, readOnly: true }
  ),
  "computer.click": computerTool("computer.click", "Click in the computer session.", {
    risk: "high",
    requiresConfirmation: false,
    readOnly: false
  }),
  "computer.type": computerTool("computer.type", "Type into the computer session.", {
    risk: "high",
    requiresConfirmation: false,
    readOnly: false
  }),
  "computer.scroll": computerTool("computer.scroll", "Scroll the computer session.", {
    risk: "low",
    requiresConfirmation: false,
    readOnly: true
  }),
  "computer.upload": computerTool("computer.upload", "Upload a trusted file reference.", {
    risk: "high",
    requiresConfirmation: true,
    readOnly: false
  }),
  "computer.control.take": computerTool(
    "computer.control.take",
    "Transfer control of the computer session to the human user.",
    { risk: "medium", requiresConfirmation: false, readOnly: false }
  ),
  "computer.control.release": computerTool(
    "computer.control.release",
    "Return control of the computer session to Grogoni after a fresh observation.",
    { risk: "medium", requiresConfirmation: false, readOnly: false }
  ),
  "computer.checkpoint": computerTool(
    "computer.checkpoint",
    "Checkpoint computer session state into RuntimeHandoff metadata.",
    { risk: "medium", requiresConfirmation: false, readOnly: false }
  ),
  "computer.suspend": computerTool("computer.suspend", "Suspend the computer session.", {
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false
  }),
  "computer.close": computerTool("computer.close", "Close the computer session.", {
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false
  })
} satisfies Partial<Record<RuntimeToolName, RuntimeToolDefinition>>;
