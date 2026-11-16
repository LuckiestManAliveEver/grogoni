import { Cp2Error } from "./cp2-error.js";
import { isWeakPin } from "@grogoni/shared-types";

export { isWeakPin };

/**
 * Throws a 400 Cp2Error when the PIN is too weak to set. Call AFTER normalizePin, and ONLY on
 * PIN-establishing flows - not when verifying a submitted PIN.
 */
export function assertAcceptablePin(pin: string): void {
  if (isWeakPin(pin)) {
    throw new Cp2Error(
      400,
      "pin_weak",
      "Choose a less predictable PIN. Avoid repeated digits (like 0000), simple sequences (like 1234), and common patterns."
    );
  }
}
