import type { AgentDefinitionId, ModelExecutionTarget, OssAgentSummary } from "./index.js";

export interface PortableAgentToolRequirement {
  name: string;
  required: boolean;
}

export interface PortableAgentManifest {
  schemaVersion: "1";
  /** Which registered AgentRuntimeAdapter this agent runs on (e.g. "pi", "grogoni"). Absent defaults
   *  to "grogoni" at import time - this only ever selects among adapters Grogoni already ships and
   *  trusts, it never supplies adapter code, so it carries none of the harness-import security
   *  boundary that third-party executable adapters would. */
  runtimeAdapterId?: string;
  agent: {
    id: AgentDefinitionId;
    name: string;
    description?: string;
    version: string;
  };
  instructions: {
    system?: string;
    /** Manifest-relative, declarative context files. Absolute/device paths are rejected. */
    files?: string[];
  };
  capabilities: string[];
  tools: PortableAgentToolRequirement[];
  modelRequirements: {
    preferredModelId?: string;
    requiredCapabilities?: string[];
    minimumContextWindow?: number;
    localAllowed: boolean;
    hostedAllowed: boolean;
  };
  executionRequirements: {
    preferredTargets?: ModelExecutionTarget[];
    requiresNetwork: boolean;
    requiresFilesystem: boolean;
    requiresNativeBridge: boolean;
  };
  memory?: {
    scope: "conversation" | "user" | "shop" | "agent";
  };
  permissions?: {
    toolApproval: "always" | "writes" | "never";
    network: "none" | "restricted" | "allowed";
    filesystem: "none" | "sandboxed";
  };
  metadata?: Record<string, unknown>;
}

export type AgentImportSource =
  { kind: "grogoni-manifest"; manifest: unknown } | { kind: "catalog-record"; record: unknown };

export interface AgentImportInspection {
  supported: boolean;
  valid: boolean;
  agentId: AgentDefinitionId | null;
  name: string | null;
  issues: PortableAgentManifestIssue[];
}

export interface AgentImporter {
  supports(source: AgentImportSource): boolean;
  inspect(source: AgentImportSource): Promise<AgentImportInspection>;
  convert(source: AgentImportSource): Promise<PortableAgentManifest>;
}

export interface PortableAgentManifestIssue {
  path: string;
  message: string;
}

export type PortableAgentManifestValidation =
  | { valid: true; manifest: PortableAgentManifest; issues: [] }
  | { valid: false; manifest: null; issues: PortableAgentManifestIssue[] };

/**
 * Converts discovery metadata into Grogoni's declarative definition. Repository runtime names remain
 * provenance metadata; no repository executable, endpoint, credential, or device binding crosses
 * into the runtime contract.
 */
export function portableAgentManifestFromOssAgent(agent: OssAgentSummary): PortableAgentManifest {
  return {
    schemaVersion: "1",
    agent: {
      id: agent.id,
      name: agent.label,
      description: agent.description,
      version: agent.updatedAt ?? "unversioned"
    },
    instructions: {
      system: `Act as ${agent.label} through Grogoni's bounded instructions, tools, and permission policy.`
    },
    capabilities: [...new Set(agent.capabilities)].sort(),
    tools: [],
    modelRequirements: {
      requiredCapabilities: ["chat"],
      localAllowed: true,
      hostedAllowed: true
    },
    executionRequirements: {
      preferredTargets: ["backend", "remote-shop-device"],
      requiresNetwork: false,
      requiresFilesystem: false,
      requiresNativeBridge: false
    },
    memory: { scope: "shop" },
    permissions: {
      toolApproval: "writes",
      network: "restricted",
      filesystem: "sandboxed"
    },
    metadata: {
      importSource: agent.source,
      sourceId: agent.sourceId,
      sourceUrl: agent.sourceUrl,
      license: agent.license,
      sourceRuntime: agent.runtime
    }
  };
}

const runtimeAdapterIdPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const executionTargets = new Set<ModelExecutionTarget>(["backend", "remote-shop-device"]);
const memoryScopes = new Set(["conversation", "user", "shop", "agent"]);
const toolApprovalModes = new Set(["always", "writes", "never"]);
const networkModes = new Set(["none", "restricted", "allowed"]);
const filesystemModes = new Set(["none", "sandboxed"]);
const prohibitedKeys = new Set([
  "apikey",
  "api_key",
  "binarypath",
  "command",
  "deviceid",
  "devicepath",
  "endpoint",
  "executable",
  "executionhostid",
  "installedruntimeid",
  "localmodelid",
  "password",
  "providermodelid",
  "secret",
  "shell",
  "token"
]);

export function validatePortableAgentManifest(value: unknown): PortableAgentManifestValidation {
  const issues: PortableAgentManifestIssue[] = [];
  const root = readRecord(value, "$", issues);
  if (root === null) return invalid(issues);
  rejectProhibitedKeys(root, "$", issues, 0);

  if (root.schemaVersion !== "1") issue(issues, "$.schemaVersion", 'must equal "1"');
  if (
    root.runtimeAdapterId !== undefined &&
    (typeof root.runtimeAdapterId !== "string" ||
      !runtimeAdapterIdPattern.test(root.runtimeAdapterId))
  ) {
    issue(issues, "$.runtimeAdapterId", "must be a lowercase registered adapter identifier");
  }
  const agent = readRecord(root.agent, "$.agent", issues);
  if (agent !== null) {
    if (!isPortableAgentDefinitionId(agent.id)) issue(issues, "$.agent.id", "is invalid");
    boundedString(agent.name, "$.agent.name", issues, 1, 160);
    optionalBoundedString(agent.description, "$.agent.description", issues, 2_000);
    boundedString(agent.version, "$.agent.version", issues, 1, 80);
  }

  const instructions = readRecord(root.instructions, "$.instructions", issues);
  if (instructions !== null) {
    optionalBoundedString(instructions.system, "$.instructions.system", issues, 32_000);
    const files = optionalStringArray(instructions.files, "$.instructions.files", issues, 32, 240);
    for (const [index, file] of files.entries()) {
      if (
        file.startsWith("/") ||
        /^[a-zA-Z]:[\\/]/u.test(file) ||
        file.split(/[\\/]/u).includes("..") ||
        /^[a-z][a-z0-9+.-]*:/iu.test(file)
      ) {
        issue(issues, `$.instructions.files[${index}]`, "must be a manifest-relative context file");
      }
    }
  }

  stringArray(root.capabilities, "$.capabilities", issues, 64, 100);
  const tools = Array.isArray(root.tools) ? root.tools : null;
  if (tools === null) {
    issue(issues, "$.tools", "must be an array");
  } else if (tools.length > 128) {
    issue(issues, "$.tools", "must contain at most 128 entries");
  } else {
    tools.forEach((value, index) => {
      const tool = readRecord(value, `$.tools[${index}]`, issues);
      if (tool === null) return;
      const name = boundedString(tool.name, `$.tools[${index}].name`, issues, 1, 160);
      if (name !== null && !/^[a-z0-9][a-z0-9._:/-]*$/iu.test(name)) {
        issue(issues, `$.tools[${index}].name`, "must be a declarative tool identifier");
      }
      if (typeof tool.required !== "boolean") {
        issue(issues, `$.tools[${index}].required`, "must be a boolean");
      }
    });
  }

  const model = readRecord(root.modelRequirements, "$.modelRequirements", issues);
  if (model !== null) {
    optionalBoundedString(
      model.preferredModelId,
      "$.modelRequirements.preferredModelId",
      issues,
      220
    );
    optionalStringArray(
      model.requiredCapabilities,
      "$.modelRequirements.requiredCapabilities",
      issues,
      64,
      100
    );
    if (
      model.minimumContextWindow !== undefined &&
      (!Number.isSafeInteger(model.minimumContextWindow) ||
        (model.minimumContextWindow as number) < 1 ||
        (model.minimumContextWindow as number) > 10_000_000)
    ) {
      issue(issues, "$.modelRequirements.minimumContextWindow", "must be a positive safe integer");
    }
    booleanValue(model.localAllowed, "$.modelRequirements.localAllowed", issues);
    booleanValue(model.hostedAllowed, "$.modelRequirements.hostedAllowed", issues);
    if (model.localAllowed === false && model.hostedAllowed === false) {
      issue(issues, "$.modelRequirements", "must allow at least one execution location");
    }
  }

  const execution = readRecord(root.executionRequirements, "$.executionRequirements", issues);
  if (execution !== null) {
    if (execution.preferredTargets !== undefined) {
      if (!Array.isArray(execution.preferredTargets)) {
        issue(issues, "$.executionRequirements.preferredTargets", "must be an array");
      } else {
        if (execution.preferredTargets.length > executionTargets.size) {
          issue(issues, "$.executionRequirements.preferredTargets", "contains too many targets");
        }
        const seen = new Set<unknown>();
        execution.preferredTargets.forEach((target, index) => {
          if (!executionTargets.has(target as ModelExecutionTarget)) {
            issue(
              issues,
              `$.executionRequirements.preferredTargets[${index}]`,
              "is not a supported execution target"
            );
          }
          if (seen.has(target)) {
            issue(
              issues,
              `$.executionRequirements.preferredTargets[${index}]`,
              "must not be duplicated"
            );
          }
          seen.add(target);
        });
      }
    }
    booleanValue(execution.requiresNetwork, "$.executionRequirements.requiresNetwork", issues);
    booleanValue(
      execution.requiresFilesystem,
      "$.executionRequirements.requiresFilesystem",
      issues
    );
    booleanValue(
      execution.requiresNativeBridge,
      "$.executionRequirements.requiresNativeBridge",
      issues
    );
  }

  if (root.memory !== undefined) {
    const memory = readRecord(root.memory, "$.memory", issues);
    if (memory !== null && !memoryScopes.has(memory.scope as string)) {
      issue(issues, "$.memory.scope", "is invalid");
    }
  }
  if (root.permissions !== undefined) {
    const permissions = readRecord(root.permissions, "$.permissions", issues);
    if (permissions !== null) {
      if (!toolApprovalModes.has(permissions.toolApproval as string)) {
        issue(issues, "$.permissions.toolApproval", "is invalid");
      }
      if (!networkModes.has(permissions.network as string)) {
        issue(issues, "$.permissions.network", "is invalid");
      }
      if (!filesystemModes.has(permissions.filesystem as string)) {
        issue(issues, "$.permissions.filesystem", "is invalid");
      }
    }
  }
  if (root.metadata !== undefined && readRecord(root.metadata, "$.metadata", issues) !== null) {
    try {
      if (JSON.stringify(root.metadata).length > 32_000) {
        issue(issues, "$.metadata", "must be at most 32,000 serialized characters");
      }
    } catch {
      issue(issues, "$.metadata", "must be JSON serializable");
    }
  }

  if (issues.length > 0) return invalid(issues);
  return { valid: true, manifest: structuredClone(value) as PortableAgentManifest, issues: [] };
}

function invalid(issues: PortableAgentManifestIssue[]): PortableAgentManifestValidation {
  return { valid: false, manifest: null, issues };
}

function readRecord(
  value: unknown,
  path: string,
  issues: PortableAgentManifestIssue[]
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue(issues, path, "must be an object");
    return null;
  }
  return value as Record<string, unknown>;
}

function stringArray(
  value: unknown,
  path: string,
  issues: PortableAgentManifestIssue[],
  maximumItems: number,
  maximumLength: number
): string[] {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array");
    return [];
  }
  if (value.length > maximumItems)
    issue(issues, path, `must contain at most ${maximumItems} entries`);
  return value.flatMap((item, index) => {
    const parsed = boundedString(item, `${path}[${index}]`, issues, 1, maximumLength);
    return parsed === null ? [] : [parsed];
  });
}

function optionalStringArray(
  value: unknown,
  path: string,
  issues: PortableAgentManifestIssue[],
  maximumItems: number,
  maximumLength: number
): string[] {
  return value === undefined ? [] : stringArray(value, path, issues, maximumItems, maximumLength);
}

function boundedString(
  value: unknown,
  path: string,
  issues: PortableAgentManifestIssue[],
  minimumLength: number,
  maximumLength: number
): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length < minimumLength ||
    value.length > maximumLength
  ) {
    issue(
      issues,
      path,
      `must be a string between ${minimumLength} and ${maximumLength} characters`
    );
    return null;
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  path: string,
  issues: PortableAgentManifestIssue[],
  maximumLength: number
): void {
  if (value !== undefined) boundedString(value, path, issues, 1, maximumLength);
}

function booleanValue(value: unknown, path: string, issues: PortableAgentManifestIssue[]): void {
  if (typeof value !== "boolean") issue(issues, path, "must be a boolean");
}

function rejectProhibitedKeys(
  value: unknown,
  path: string,
  issues: PortableAgentManifestIssue[],
  depth: number
): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectProhibitedKeys(item, `${path}[${index}]`, issues, depth + 1)
    );
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (prohibitedKeys.has(key.toLowerCase())) {
      issue(issues, `${path}.${key}`, "is not allowed in a portable agent manifest");
    }
    rejectProhibitedKeys(item, `${path}.${key}`, issues, depth + 1);
  }
}

function isPortableAgentDefinitionId(value: unknown): value is AgentDefinitionId {
  return (
    typeof value === "string" &&
    value.length <= 220 &&
    (/^(?:builtin|portable):[a-z0-9][a-z0-9_-]{0,79}$/u.test(value) ||
      /^(?:github|huggingface):[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(value))
  );
}

function issue(issues: PortableAgentManifestIssue[], path: string, message: string): void {
  issues.push({ path, message });
}
