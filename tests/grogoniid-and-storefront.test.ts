import { describe, expect, it } from "vitest";
import { isGrogoniId, normalizeGrogoniId } from "../apps/web/src/grogoniid-and-storefront";

describe("readable Grogoni storefront IDs", () => {
  it("accepts and canonicalizes readable IDs", () => {
    expect(isGrogoniId("grogoni.janes-shop")).toBe(true);
    expect(isGrogoniId(" GROGONI.JANES-SHOP ")).toBe(true);
    expect(normalizeGrogoniId(" GROGONI.JANES-SHOP ")).toBe("grogoni.janes-shop");
    expect(isGrogoniId("grogoni.-janes-shop")).toBe(false);
    expect(isGrogoniId("grogoni.janes_shop")).toBe(false);
    expect(isGrogoniId("254A00000001")).toBe(false);
  });
});
