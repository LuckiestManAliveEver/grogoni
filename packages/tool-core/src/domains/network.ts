import type { RuntimeToolDefinition, RuntimeToolName } from "../contracts/runtime.js";

export const networkRuntimeTools = {
  "network.route": {
    name: "network.route",
    hub: {
      module: "network",
      label: { en: "Route to another shop", sw: "Elekeza kwa duka jingine" }
    },
    description: "Request an agent-mediated route to a matching second-degree network contact.",
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "business:read",
    inputSchema: {
      type: "object",
      properties: {
        requestText: {
          type: "string",
          required: true,
          description: "The owner's original network-discovery request."
        },
        targetNodeId: {
          type: "string",
          description: "Optional canonical network node identifier."
        }
      }
    },
    mcpExposable: false
  },
  "network.contacts.resolve": {
    name: "network.contacts.resolve",
    hub: {
      module: "network",
      label: { en: "Find a contact on Grogoni", sw: "Tafuta mawasiliano kwenye Grogoni" }
    },
    description: "Resolve a name, phone, email, or handle against the owner's own phonebook.",
    risk: "low",
    requiresConfirmation: false,
    readOnly: true,
    requiredPermission: "business:read",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          required: true,
          description: "Name, phone, email, or handle fragment to resolve."
        }
      }
    },
    mcpExposable: false
  },
  "network.identity.list": {
    name: "network.identity.list",
    hub: {
      module: "network",
      label: { en: "Review contact matches", sw: "Kagua mechi za mawasiliano" }
    },
    description: "List pending identity candidates awaiting the owner's confirmation.",
    risk: "low",
    requiresConfirmation: false,
    readOnly: true,
    requiredPermission: "business:read",
    inputSchema: { type: "object", properties: {} },
    mcpExposable: false
  },
  "network.identity.propose": {
    name: "network.identity.propose",
    hub: {
      module: "network",
      label: { en: "Suggest a contact match", sw: "Pendekeza mechi ya mawasiliano" }
    },
    description:
      "Record a candidate identity seen while completing another task (e.g. a browsing " +
      "observation) as pending - never attaches it to the phonebook until the owner confirms it.",
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "business:write",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", required: true, description: "Where this identity was seen." },
        providerSubject: {
          type: "string",
          required: true,
          description: "The provider-specific identifier or handle observed."
        },
        displayName: {
          type: "string",
          required: true,
          description: "The name observed alongside this identity."
        },
        handle: { type: "string", description: "Optional public handle observed." },
        evidence: {
          type: "string",
          required: true,
          description: "Human-readable context for why this identity was proposed."
        }
      }
    },
    mcpExposable: false
  },
  "network.identity.confirm": {
    name: "network.identity.confirm",
    hub: {
      module: "network",
      label: { en: "Confirm a contact match", sw: "Thibitisha mechi ya mawasiliano" }
    },
    description:
      "Confirm a pending identity candidate, attaching it to an existing contact or a new one.",
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "business:write",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string", required: true, description: "Identity candidate ID." },
        targetNodeId: {
          type: "string",
          description: "Existing contact to attach this identity to, if not the guessed one."
        },
        createNewContact: {
          type: "boolean",
          description: "True to create a brand-new contact for this identity."
        }
      }
    },
    mcpExposable: false
  },
  "network.identity.reject": {
    name: "network.identity.reject",
    hub: {
      module: "network",
      label: { en: "Reject a contact match", sw: "Kataa mechi ya mawasiliano" }
    },
    description: "Reject a pending identity candidate - it is discarded, never attached.",
    risk: "low",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "business:write",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string", required: true, description: "Identity candidate ID." }
      }
    },
    mcpExposable: false
  },
  "network.identity.unlink": {
    name: "network.identity.unlink",
    hub: { module: "network", label: { en: "Unlink a contact", sw: "Tenganisha mawasiliano" } },
    description: "Remove a previously confirmed identity from a contact.",
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "business:write",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", required: true, description: "Canonical network node ID." },
        externalIdentityId: {
          type: "string",
          required: true,
          description: "Identity to unlink from this contact."
        }
      }
    },
    mcpExposable: false
  },
  "network.identity.add": {
    name: "network.identity.add",
    hub: {
      module: "network",
      label: { en: "Link a contact yourself", sw: "Unganisha mawasiliano mwenyewe" }
    },
    description: "Directly add an owner-authored identity (e.g. a known handle) to a contact.",
    risk: "low",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "business:write",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", required: true, description: "Canonical network node ID." },
        provider: { type: "string", required: true, description: "Identity provider or channel." },
        providerSubject: {
          type: "string",
          required: true,
          description: "Provider-specific identifier or handle."
        },
        displayName: { type: "string", description: "Optional display name override." },
        handle: { type: "string", description: "Optional public handle." }
      }
    },
    mcpExposable: false
  }
} satisfies Partial<Record<RuntimeToolName, RuntimeToolDefinition>>;
