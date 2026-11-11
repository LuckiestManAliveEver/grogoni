import { describe, expect, it } from "vitest";
import { EmailDeliveryError } from "../services/api/src/cp2/email-provider";
import { Cp2Error } from "../services/api/src/cp2/cp2-error";

describe("email provider runtime error contract", () => {
  it("exports the typed error imported by the API entrypoint and keeps provider details out of its message", () => {
    const error = new EmailDeliveryError(429, "too_many_requests");
    expect(error).toBeInstanceOf(Cp2Error);
    expect(error).toMatchObject({
      statusCode: 502,
      code: "email_delivery_failed",
      providerStatus: 429,
      providerCode: "too_many_requests"
    });
    expect(error.message).not.toContain("too_many_requests");
  });
});
