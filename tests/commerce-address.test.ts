import { describe, expect, it } from "vitest";
// Imported via the API's re-export (not the bare "@grogoni/shared-types" specifier) because this
// root-level tests/ directory has no direct dependency on that workspace package - only services/
// and apps/ do - so only a relative import through one of them resolves here at runtime.
import {
  commerceAddressFromGrogoniId,
  normalizeCommerceAddress,
  grogoniIdFromCommerceAddress
} from "../services/api/src/cp2/text-normalization";

describe("commerceAddressFromGrogoniId", () => {
  it("strips the grogoni. prefix and appends @grogoni.com", () => {
    expect(commerceAddressFromGrogoniId("grogoni.mama-mboga")).toBe("mama-mboga@grogoni.com");
  });

  it("lowercases and trims", () => {
    expect(commerceAddressFromGrogoniId("  Grogoni.Mama-Mboga  ")).toBe("mama-mboga@grogoni.com");
  });
});

describe("grogoniIdFromCommerceAddress", () => {
  it("recovers the grogoniId from a commerce address", () => {
    expect(grogoniIdFromCommerceAddress("mama-mboga@grogoni.com")).toBe("grogoni.mama-mboga");
  });

  it("also accepts a bare grogoniId-shaped handle", () => {
    expect(grogoniIdFromCommerceAddress("grogoni.mama-mboga")).toBe("grogoni.mama-mboga");
  });
});

describe("normalizeCommerceAddress", () => {
  it("round-trips through grogoniId so it is idempotent regardless of input casing/whitespace", () => {
    expect(normalizeCommerceAddress("  MAMA-MBOGA@GROGONI.COM  ")).toBe("mama-mboga@grogoni.com");
  });
});
