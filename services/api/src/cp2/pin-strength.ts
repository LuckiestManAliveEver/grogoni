import { Cp2Error } from "./cp2-error.js";

/**
 * Login PINs are 4 digits, so the whole keyspace is only 10,000 combinations. Online guessing is
 * rate limited (see pinMaximumFailedAttempts in store.ts), but the dominant real-world risk is not
 * exhaustive search - it is *predictable* PINs. A small set of values (0000, 1234, 1111, repeated
 * and sequential digits, a handful of popular patterns) accounts for a large share of the PINs
 * people actually choose, so an attacker spends their limited attempts on those first.
 *
 * We therefore refuse to *set* a weak PIN. This is enforced only when a new PIN is established
 * (sign-up, set, change, guest upgrade, recovery) - never on the verification path, so existing
 * accounts that already have a weak PIN can still sign in (and are prompted to change it elsewhere)
 * rather than being locked out by a policy change.
 */

// Frequently chosen non-ladder PINs: keypad patterns, repeated pairs, and well-known popular
// values. Constant-step ladders (1234, 2468, 8642, ...) are handled by isArithmeticLadder below,
// so they are intentionally not listed here. Kept explicit so the policy is auditable.
const EXPLICIT_WEAK_PINS = new Set<string>([
  "1212",
  "1004",
  "2000",
  "6969",
  "1122",
  "1313",
  "2001",
  "1010",
  "2580", // straight down the middle of the keypad
  "0852", // same column, bottom to top
  "1123",
  "1324"
]);

function isAllSameDigit(pin: string): boolean {
  return pin[0] === pin[1] && pin[1] === pin[2] && pin[2] === pin[3];
}

// True for a constant-step run of ±1 or ±2: 1234/4321 (±1) and 2468/1357/8642/7531 (±2). These
// skip-counting ladders are among the first an attacker tries, so they are treated the same way
// in both directions rather than only ascending.
function isArithmeticLadder(pin: string): boolean {
  const step = pin.charCodeAt(1) - pin.charCodeAt(0);
  if (step !== 1 && step !== -1 && step !== 2 && step !== -2) return false;
  for (let i = 2; i < pin.length; i += 1) {
    if (pin.charCodeAt(i) - pin.charCodeAt(i - 1) !== step) return false;
  }
  return true;
}

/**
 * True when `pin` is too predictable to be allowed as a newly set PIN. Assumes `pin` is exactly
 * four digits (callers run normalizePin first); any non-conforming value is treated as weak.
 */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (isAllSameDigit(pin)) return true; // 0000, 1111, ... 9999
  if (isArithmeticLadder(pin)) return true; // 1234, 4321, 2468, 8642, ...
  return EXPLICIT_WEAK_PINS.has(pin);
}

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
