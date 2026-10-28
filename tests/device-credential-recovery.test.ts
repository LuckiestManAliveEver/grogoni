import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("device credential recovery", () => {
  it("requires device proof, permits one reset, and does not replenish proof on replay", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/continue",
        payload: { contact: "0712345699", country: "KE", pin: "1234" }
      });
      expect(signup.statusCode).toBe(200);
      const cookie = signup.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const bound = await app.inject({
        method: "POST",
        url: "/auth/continue",
        headers: { cookie },
        payload: { devicePublicKeyJwk: publicKey.export({ format: "jwk" }) }
      });
      expect(bound.statusCode).toBe(200);
      const denied = await app.inject({
        method: "POST",
        url: "/auth/pin/recover/device",
        headers: { cookie },
        payload: { pin: "5678" }
      });
      expect(denied.statusCode).toBe(401);
      const credentialId = bound.json().deviceRecoveryCredentialId;
      const issuedAt = Date.now();
      const nonce = randomBytes(24).toString("base64url");
      const signature = sign(
        "sha256",
        Buffer.from(`grogoni-device-recovery:v1:${credentialId}:${issuedAt}:${nonce}`),
        { key: privateKey, dsaEncoding: "ieee-p1363" }
      ).toString("base64url");
      const payload = { credentialId, issuedAt, nonce, signature };
      const proof = await app.inject({ method: "POST", url: "/auth/device/recover", payload });
      expect(proof.statusCode).toBe(200);
      const recoveredCookie = proof.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const reset = await app.inject({
        method: "POST",
        url: "/auth/pin/recover/device",
        headers: { cookie: recoveredCookie },
        payload: { pin: "5678" }
      });
      expect(reset.statusCode).toBe(200);
      const replay = await app.inject({ method: "POST", url: "/auth/device/recover", payload });
      expect(replay.statusCode).toBe(200);
      const repeated = await app.inject({
        method: "POST",
        url: "/auth/password/recover/device",
        headers: { cookie: recoveredCookie },
        payload: { password: "new secure password", passwordConfirmation: "new secure password" }
      });
      expect(repeated.statusCode).toBe(401);
      const retired = await app.inject({
        method: "POST",
        url: "/auth/pin/recover/passkey",
        headers: { cookie },
        payload: { pin: "9999" }
      });
      expect(retired.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
