import {
  invalid,
  type RuntimeToolName,
  type RuntimeToolProposal,
  type ValidationResult
} from "../contracts/runtime.js";
import { runtimeToolRegistry } from "../registry/index.js";
import { validateRuntimeToolInput } from "../validation/runtime.js";

export interface RuntimeHashtagCapability {
  description: string;
  hashtag: `#${RuntimeToolName}`;
  inputFields: string[];
  module: string;
  readOnly: boolean;
  requiresConfirmation: boolean;
  risk: (typeof runtimeToolRegistry)[RuntimeToolName]["risk"];
  toolName: RuntimeToolName;
}

export interface RuntimeHashtagInvocation {
  command: string;
  proposal: RuntimeToolProposal;
  toolName: RuntimeToolName | null;
}

/**
 * A presentation-safe projection of the canonical registry. The chat picker and parser both use
 * this projection so a newly registered runtime capability automatically receives a # command.
 */
export const runtimeHashtagCapabilities: RuntimeHashtagCapability[] = (
  Object.keys(runtimeToolRegistry) as RuntimeToolName[]
).map((toolName) => {
  const definition = runtimeToolRegistry[toolName];
  return {
    description: definition.description,
    hashtag: `#${toolName}`,
    inputFields: Object.keys(definition.inputSchema.properties),
    module: toolName.split(".", 1)[0] ?? toolName,
    readOnly: definition.readOnly,
    requiresConfirmation: definition.requiresConfirmation,
    risk: definition.risk,
    toolName
  };
});

/** Return the command fragment while the user is typing a leading # command. */
export function runtimeHashtagQuery(message: string): string | null {
  const match = /^\s*#([a-z0-9_.-]*)$/i.exec(message);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Parse a leading # command into a server-authorizable runtime proposal. Casual hashtags later in
 * a sentence are deliberately ignored. JSON is the universal input form; tools with a `query`
 * field or one required string field additionally accept convenient plain text.
 */
export function parseRuntimeHashtagInvocation(message: string): RuntimeHashtagInvocation | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("#")) return null;

  const match = /^#([a-z0-9_.-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (match === null) {
    return invalidInvocation(
      "",
      "Use # followed by a capability name, for example #products.list."
    );
  }

  const command = (match[1] ?? "").toLowerCase();
  if (command.length === 0) {
    return invalidInvocation(
      command,
      "Choose a capability after #. Start typing to search the available shop modules."
    );
  }
  if (!Object.hasOwn(runtimeToolRegistry, command)) {
    return invalidInvocation(
      command,
      `Unknown capability #${command}. Type # in chat to choose an available capability.`
    );
  }

  const toolName = command as RuntimeToolName;
  const rawInput = (match[2] ?? "").trim();
  const parsedInput = parseHashtagInput(toolName, rawInput);
  const validation = mergeValidation(
    parsedInput.validation,
    validateRuntimeToolInput(toolName, parsedInput.input)
  );
  return {
    command,
    toolName,
    proposal: {
      toolName,
      input: parsedInput.input,
      reason: `Explicit chat capability #${toolName}.`,
      validation
    }
  };
}

function parseHashtagInput(
  toolName: RuntimeToolName,
  rawInput: string
): { input: Record<string, unknown>; validation: ValidationResult } {
  if (rawInput.length === 0) return { input: {}, validation: { ok: true, errors: [] } };

  if (rawInput.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(rawInput);
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        return {
          input: {},
          validation: invalid("Hashtag capability input must be a JSON object.")
        };
      }
      return { input: value as Record<string, unknown>, validation: { ok: true, errors: [] } };
    } catch {
      return {
        input: {},
        validation: invalid(`The JSON after #${toolName} is not valid.`)
      };
    }
  }

  const properties = runtimeToolRegistry[toolName].inputSchema.properties;
  if (properties.query?.type === "string") {
    return { input: { query: rawInput }, validation: { ok: true, errors: [] } };
  }
  const requiredStringFields = Object.entries(properties).filter(
    ([, field]) => field.required === true && field.type === "string"
  );
  const requiredFields = Object.entries(properties).filter(([, field]) => field.required === true);
  if (requiredFields.length === 1 && requiredStringFields.length === 1) {
    return {
      input: { [requiredStringFields[0]![0]]: rawInput },
      validation: { ok: true, errors: [] }
    };
  }

  return {
    input: {},
    validation: invalid(
      `Pass #${toolName} input as a JSON object using these fields: ${
        Object.keys(properties).join(", ") || "none"
      }.`
    )
  };
}

function invalidInvocation(command: string, error: string): RuntimeHashtagInvocation {
  return {
    command,
    toolName: null,
    proposal: {
      toolName: "unknown.clarify",
      input: {},
      reason: "The requested hashtag capability could not be resolved.",
      validation: invalid(error)
    }
  };
}

function mergeValidation(first: ValidationResult, second: ValidationResult): ValidationResult {
  const errors = [...first.errors, ...second.errors];
  return errors.length === 0 ? { ok: true, errors: [] } : invalid(...errors);
}
