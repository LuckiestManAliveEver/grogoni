import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { E2eeDeviceSummary, E2eePublicKey } from "@grogoni/shared-types";
import {
  decryptDirectMessage,
  encryptDirectMessage,
  type E2eeIdentity
} from "../apps/web/src/e2ee";

describe("human direct-message encryption", () => {
  it("round-trips text and attachments without placing plaintext in the wire content", async () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits"
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const publicKey: E2eePublicKey = {
      kty: "EC",
      crv: "P-256",
      x: jwk.x as string,
      y: jwk.y as string,
      ext: true
    };
    const identity: E2eeIdentity = {
      deviceId: "device-crypto-roundtrip",
      privateKey: pair.privateKey,
      publicKey
    };
    const device: E2eeDeviceSummary = {
      id: identity.deviceId,
      accountId: "account-1",
      label: "Test",
      publicKey,
      createdAt: "2026-07-15T12:00:00.000Z",
      lastSeenAt: "2026-07-15T12:00:00.000Z",
      revokedAt: null
    };
    const message = {
      text: "private delivery note",
      attachments: [
        {
          id: "attachment-1",
          name: "private.txt",
          mimeType: "text/plain",
          size: 6,
          category: "document" as const,
          url: "data:text/plain;base64,c2VjcmV0"
        }
      ]
    };

    const content = await encryptDirectMessage({
      conversationId: "conversation-crypto-test",
      devices: [device],
      message
    });

    expect(content.type).toBe("encrypted");
    expect(JSON.stringify(content)).not.toContain(message.text);
    expect(JSON.stringify(content)).not.toContain(message.attachments[0]?.url);
    if (content.type !== "encrypted") throw new Error("Expected encrypted content.");
    await expect(
      decryptDirectMessage({
        conversationId: "conversation-crypto-test",
        content,
        identity
      })
    ).resolves.toEqual(message);
  });
});
