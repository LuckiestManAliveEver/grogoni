import { describe, expect, it } from "vitest";
import { isWeakPin as sharedIsWeakPin } from "../packages/shared-types/src/pin-strength";
import { isWeakPin as edgeIsWeakPin } from "../supabase/functions/api/auth-routes";

describe("edge PIN strength copy", () => {
  it("agrees with the shared rule for every 4-digit PIN", () => {
    for (let value = 0; value < 10000; value += 1) {
      const pin = String(value).padStart(4, "0");
      expect(edgeIsWeakPin(pin), pin).toBe(sharedIsWeakPin(pin));
    }
  });
});
