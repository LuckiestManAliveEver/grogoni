import { X509Certificate } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  androidAttestationChallenge,
  androidAttestationProblem,
  fetchAndroidRevokedSerials,
  grogoniAndroidPackage,
  grogoniAndroidSigners
} from "../services/api/src/cp2/android-key-attestation";
import { androidAttestationRoots } from "../services/api/src/cp2/android-attestation-roots";
import { createCp2Store } from "../services/api/src/cp2/store";
import { generateKeyPairSync } from "node:crypto";

// A real Keystore chain from the API 36 emulator (DeviceKeyAttestationInstrumentedTest). Emulators
// only produce software attestation, so the good case allows that and trusts the chain's own root.
const fixture = JSON.parse(
  readFileSync("tests/fixtures/android-attestation-emulator.json", "utf8")
);
const root = new X509Certificate(Buffer.from(fixture.chain.at(-1), "base64")).toString();
const debugSigner =
  "F9:97:AE:23:51:98:4C:EA:BF:50:FE:67:82:01:7A:ED:F2:02:8C:9C:F4:BF:61:22:D5:41:0C:51:3A:66:94:6C";
const real = {
  chain: fixture.chain,
  publicKeyJwk: fixture.publicKeyJwk,
  accountId: fixture.accountId,
  packageName: grogoniAndroidPackage,
  signerDigests: [debugSigner],
  roots: [root],
  allowSoftware: true
};

describe("Android Key Attestation", () => {
  it("accepts a real chain", () => {
    expect(androidAttestationProblem(real)).toBeNull();
  });

  it.each([
    ["no chain", { chain: undefined }, "chain_missing"],
    ["a chain of one", { chain: fixture.chain.slice(0, 1) }, "chain_missing"],
    ["an unpinned root", { roots: androidAttestationRoots }, "root_untrusted"],
    ["software attestation in production", { allowSoftware: false }, "not_hardware"],
    ["another account", { accountId: "someone-else" }, "challenge_mismatch"],
    ["another app", { packageName: "com.example.fake" }, "package_mismatch"],
    ["another signer", { signerDigests: ["00".repeat(32)] }, "signer_mismatch"],
    ["garbage", { chain: ["bm90IGEgY2VydA==", "bm90IGEgY2VydA=="] }, "attestation_malformed"],
    [
      "a broken chain",
      { chain: [fixture.chain[0], fixture.chain.at(-1)] },
      "chain_signature_invalid"
    ]
  ])("refuses %s", (_name, change, reason) => {
    expect(androidAttestationProblem({ ...real, ...change })).toBe(reason);
  });

  it("refuses a key other than the attested one", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(
      androidAttestationProblem({
        ...real,
        publicKeyJwk: other.publicKey.export({ format: "jwk" }) as Record<string, unknown>
      })
    ).toBe("key_mismatch");
  });

  it("uses an account-bound challenge and Google's two roots", () => {
    expect(androidAttestationChallenge("a")).toHaveLength(32);
    expect(androidAttestationChallenge("a")).not.toEqual(androidAttestationChallenge("b"));
    expect(androidAttestationRoots).toHaveLength(2);
    for (const pem of androidAttestationRoots) expect(new X509Certificate(pem).ca).toBe(true);
  });

  it("includes extra signers such as Play App Signing", () => {
    expect(grogoniAndroidSigners("AA, BB")).toHaveLength(3);
    expect(grogoniAndroidSigners(undefined)).toHaveLength(1);
  });
});

// Built with openssl: a hardware-level KeyDescription for the production package and signer.
const synthetic = JSON.parse(
  readFileSync("tests/fixtures/android-attestation-synthetic.json", "utf8")
);
const hardware = {
  publicKeyJwk: synthetic.publicKeyJwk,
  accountId: synthetic.accountId,
  packageName: grogoniAndroidPackage,
  signerDigests: grogoniAndroidSigners(undefined),
  roots: [synthetic.rootPem]
};

describe("hardware attestation", () => {
  it("accepts a hardware-level chain through CA intermediates", () => {
    expect(androidAttestationProblem({ ...hardware, chain: synthetic.validChain })).toBeNull();
  });

  it("refuses a leaf signed by a device's own attested key", () => {
    expect(androidAttestationProblem({ ...hardware, chain: synthetic.forgedChain })).toBe(
      "attestation_in_issuer"
    );
  });
});

// Real chains from github.com/android/keyattestation testdata (Apache-2.0), each with its capture
// date. Their challenges are not ours, so reaching challenge_mismatch means the chain, signatures
// and root were all accepted. They cover a reissued root, remote provisioning, a CA:FALSE batch
// certificate, expired factory certificates and the 2026 root.
const googleDevices = Object.entries(
  JSON.parse(
    readFileSync("tests/fixtures/android-attestation-google-devices.json", "utf8")
  ) as Record<
    string,
    { chain: string[]; publicKeyJwk: Record<string, unknown>; capturedAt: number }
  >
);
const onDevice = (device: (typeof googleDevices)[number][1]) => ({
  chain: device.chain,
  publicKeyJwk: device.publicKeyJwk,
  now: new Date(device.capturedAt),
  accountId: "x",
  packageName: grogoniAndroidPackage,
  signerDigests: grogoniAndroidSigners(undefined)
});

describe("real device chains", () => {
  it.each(googleDevices)("%s reaches the account check", (_name, device) => {
    expect(androidAttestationProblem(onDevice(device))).toBe("challenge_mismatch");
  });

  it("forgives expiry on a factory chain, but not on a remotely provisioned one", () => {
    const device = (name: string) => googleDevices.find(([key]) => key.startsWith(name))![1];
    const later = new Date("2031-01-01");
    expect(androidAttestationProblem({ ...onDevice(device("sony")), now: later })).toBe(
      "challenge_mismatch"
    );
    expect(androidAttestationProblem({ ...onDevice(device("caiman")), now: later })).toBe(
      "certificate_expired"
    );
  });

  it("refuses an issuer that is not yet valid", () => {
    const [, device] = googleDevices[0]!;
    expect(androidAttestationProblem({ ...onDevice(device), now: new Date("2000-01-01") })).toBe(
      "certificate_not_yet_valid"
    );
  });

  it("refuses a chain holding a revoked serial", () => {
    const [, device] = googleDevices[0]!;
    const serial = new X509Certificate(Buffer.from(device.chain[1]!, "base64")).serialNumber
      .toLowerCase()
      .replace(/^0+/u, "");
    expect(
      androidAttestationProblem({ ...onDevice(device), revokedSerials: new Set([serial]) })
    ).toBe("certificate_revoked");
    expect(
      androidAttestationProblem({
        ...onDevice(device),
        revokedSerials: new Set([BigInt(`0x${serial}`).toString()])
      })
    ).toBe("certificate_revoked");
  });

  it("still refuses a tampered real chain", () => {
    const [, device] = googleDevices[0]!;
    const leaf = Buffer.from(device.chain[0]!, "base64");
    leaf[leaf.length - 1]! ^= 1;
    expect(
      androidAttestationProblem({
        ...onDevice(device),
        chain: [leaf.toString("base64"), ...device.chain.slice(1)]
      })
    ).not.toBe("challenge_mismatch");
  });

  it("reads Google's revocation list, and reports when it cannot", async () => {
    const reply = new Response(JSON.stringify({ entries: { "00AB": { status: "REVOKED" } } }));
    const failing = await fetchAndroidRevokedSerials(async () => new Response("", { status: 500 }));
    expect(failing).toBeNull();
    const serials = await fetchAndroidRevokedSerials(async () => reply);
    expect(serials?.has("ab")).toBe(true);
  });
});

describe("enforcing attestation", () => {
  const enroll = () => {
    const store = createCp2Store();
    const session = store.signupWithPhonePin({ destination: "+254711223344", pin: "1234" });
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return () =>
      store.continueWithDevice({
        sessionId: session.session.id,
        idempotencyKey: null,
        devicePublicKeyJwk: publicKey.export({ format: "jwk" }),
        deviceSecurity: true,
        deviceAttestation: []
      });
  };

  it("lets an unproven key enroll until required, then refuses it", () => {
    const attempt = enroll();
    expect(attempt().deviceRecoveryCredentialId).toBeDefined();
    process.env.ANDROID_KEY_ATTESTATION_REQUIRED = "true";
    try {
      expect(enroll()).toThrowError(
        expect.objectContaining({ code: "device_attestation_required" })
      );
    } finally {
      delete process.env.ANDROID_KEY_ATTESTATION_REQUIRED;
    }
  });
});
