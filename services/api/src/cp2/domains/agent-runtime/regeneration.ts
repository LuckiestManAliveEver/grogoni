import { Cp2Error } from "../../cp2-error.js";

/**
 * Regenerated turns (docs/architecture/conversation-reply-versions.md). A turn started with
 * `regeneration: true` writes another version of a reply that already exists
 * (MessagingDomain.regenerateAgentReply). It may answer in words or run a low-risk read-only tool.
 * Anything else is refused before a plan, an approval or an execution exists. A refused turn has
 * still opened a runtime session and logged that it started; it records no turn. `regeneration` is server-only: no HTTP or MCP parser reads it.
 */

/**
 * The one refusal for a regenerated turn that would do more than answer. 409, not retryable: the
 * same message would propose the same action again; the person sends it as a new message instead.
 */
export function regenerationWouldAct(): Cp2Error {
  return new Cp2Error(
    409,
    "regeneration_would_act",
    "Another version of this reply would change business records. Send it as a new message instead.",
    false
  );
}

/**
 * The only tools a regenerated turn may run: read-only, low risk, and not the computer runtime.
 * `computer.navigate`, `computer.observe` and `computer.scroll` are registered read-only because
 * they change no business record, but they drive the merchant's signed-in browser session.
 */
export function regenerationAllowsTool(definition: {
  name: string;
  readOnly: boolean;
  risk: string;
}): boolean {
  return (
    definition.readOnly && definition.risk === "low" && !definition.name.startsWith("computer.")
  );
}

/** Called once the turn's tool is known, before its plan, approval or execution exists. */
export function assertRegenerationTool(
  input: { regeneration?: boolean },
  definition: Parameters<typeof regenerationAllowsTool>[0]
): void {
  if (input.regeneration === true && !regenerationAllowsTool(definition))
    throw regenerationWouldAct();
}

/** A regenerated turn cannot create a plan that requires shop or skill approval. */
export function assertRegenerationApproval(input: {
  regeneration?: boolean;
  channelDelegation?: unknown;
  portableSkill?: unknown;
  definition: { name: string; readOnly: boolean; requiresConfirmation: boolean };
  ownerApprovalRequiredFor: readonly string[];
  skillBinding?: { requiredConfirmationLevel: string } | undefined;
}): boolean {
  const requiresConfirmation =
    (input.channelDelegation !== undefined && !input.definition.readOnly) ||
    (input.portableSkill !== undefined && !input.definition.readOnly) ||
    input.definition.requiresConfirmation ||
    input.ownerApprovalRequiredFor.includes(input.definition.name) ||
    (input.skillBinding !== undefined && input.skillBinding.requiredConfirmationLevel !== "none");
  if (input.regeneration === true && requiresConfirmation) throw regenerationWouldAct();
  return requiresConfirmation;
}

/**
 * Called first in a turn. A regenerated turn never carries an approval being confirmed, a compiled
 * task step, a portable skill or a channel delegation: each of those exists to act.
 */
export function assertRegenerationInputs(input: {
  regeneration?: boolean;
  confirmationToken?: unknown;
  plannedStep?: unknown;
  portableSkill?: unknown;
  channelDelegation?: unknown;
}): void {
  if (
    input.regeneration === true &&
    (input.confirmationToken !== undefined ||
      input.plannedStep !== undefined ||
      input.portableSkill !== undefined ||
      input.channelDelegation !== undefined)
  )
    throw regenerationWouldAct();
}
