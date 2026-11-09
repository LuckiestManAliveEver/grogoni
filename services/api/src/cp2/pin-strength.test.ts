import { describe, expect, it } from "vitest";
import { Cp2Error } from "./cp2-error.js";
import { assertAcceptablePin, isWeakPin } from "./pin-strength.js";

describe("isWeakPin", () => {
  it("rejects repeated-digit PINs", () => {
    for (const pin of ["0000", "1111", "5555", "9999"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects ascending and descending sequences", () => {
    for (const pin of ["0123", "1234", "5678", "6789", "9876", "4321", "3210"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects constant-step ladders in both directions", () => {
    for (const pin of ["2468", "1357", "8642", "7531", "0246", "9753"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects well-known common patterns", () => {
    for (const pin of ["1212", "2580", "1004", "6969", "1122", "1010"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("treats non-4-digit input as weak", () => {
    for (const pin of ["", "12", "12345", "12a4", "abcd"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("accepts non-predictable 4-digit PINs", () => {
    for (const pin of ["0472", "8391", "6207", "1837", "9140", "3729"]) {
      expect(isWeakPin(pin)).toBe(false);
    }
  });
});

describe("assertAcceptablePin", () => {
  it("throws a 400 pin_weak error for a weak PIN", () => {
    try {
      assertAcceptablePin("0000");
      throw new Error("expected assertAcceptablePin to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Cp2Error);
      const cp2 = error as Cp2Error;
      expect(cp2.statusCode).toBe(400);
      expect(cp2.code).toBe("pin_weak");
    }
  });

  it("does not throw for an acceptable PIN", () => {
    expect(() => assertAcceptablePin("8391")).not.toThrow();
  });
});
