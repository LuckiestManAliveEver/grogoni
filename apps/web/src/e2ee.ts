import type {
  ConversationAttachment,
  ConversationMessageContent,
  E2eeDeviceSummary,
  E2eePublicKey
} from "@grogoni/shared-types";

const databaseName = "grogoni-messaging-keys-v1";
const storeName = "identities";
const algorithm = "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const;

export interface E2eeIdentity {
  deviceId: string;
  privateKey: CryptoKey;
  publicKey: E2eePublicKey;
}

export interface DecryptedMessage {
  text: string;
  attachments: ConversationAttachment[];
}

export async function ensureE2eeIdentity(accountId: string): Promise<E2eeIdentity> {
  const identityKey = `account:${accountId}`;
  const existing = await readIdentity(identityKey);
  if (existing) return existing;

  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits"
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const identity: E2eeIdentity = {
    deviceId: `device-${crypto.randomUUID()}`,
    privateKey,
    publicKey: publicKeyFromJwk(publicJwk)
  };
  await writeIdentity(identityKey, identity);
  return identity;
}

export async function encryptDirectMessage(input: {
  conversationId: string;
  devices: E2eeDeviceSummary[];
  message: DecryptedMessage;
}): Promise<ConversationMessageContent> {
  if (input.devices.length === 0) throw new Error("No encryption devices are available.");
  const plaintext = new TextEncoder().encode(JSON.stringify(input.message));
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt"
  ]);
  const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const contentCiphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: contentIv, additionalData: contentContext(input.conversationId) },
    contentKey,
    plaintext
  );
  const envelopes = await Promise.all(
    input.devices.map(async (device) => {
      const ephemeral = (await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"]
      )) as CryptoKeyPair;
      const recipientKey = await crypto.subtle.importKey(
        "jwk",
        device.publicKey,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      );
      const sharedSecret = await crypto.subtle.deriveBits(
        { name: "ECDH", public: recipientKey },
        ephemeral.privateKey,
        256
      );
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const context = encryptionContext(input.conversationId, device.id);
      const key = await deriveMessageKey(sharedSecret, salt, context);
      const wrappedKey = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: context },
        key,
        rawContentKey
      );
      return {
        version: 1 as const,
        algorithm,
        recipientDeviceId: device.id,
        ephemeralPublicKey: publicKeyFromJwk(
          await crypto.subtle.exportKey("jwk", ephemeral.publicKey)
        ),
        salt: toBase64Url(salt),
        iv: toBase64Url(iv),
        ciphertext: toBase64Url(new Uint8Array(wrappedKey))
      };
    })
  );
  return {
    type: "encrypted",
    envelopes,
    attachmentCount: input.message.attachments.length,
    iv: toBase64Url(contentIv),
    ciphertext: toBase64Url(new Uint8Array(contentCiphertext))
  };
}

export async function decryptDirectMessage(input: {
  conversationId: string;
  content: Extract<ConversationMessageContent, { type: "encrypted" }>;
  identity: E2eeIdentity;
}): Promise<DecryptedMessage> {
  const envelope = input.content.envelopes.find(
    (candidate) => candidate.recipientDeviceId === input.identity.deviceId
  );
  if (!envelope) throw new Error("This device is not a recipient of the encrypted message.");
  const ephemeralKey = await crypto.subtle.importKey(
    "jwk",
    envelope.ephemeralPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeralKey },
    input.identity.privateKey,
    256
  );
  const context = encryptionContext(input.conversationId, input.identity.deviceId);
  const key = await deriveMessageKey(sharedSecret, fromBase64Url(envelope.salt), context);
  const rawContentKey = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(envelope.iv),
      additionalData: context
    },
    key,
    fromBase64Url(envelope.ciphertext)
  );
  const contentKey = await crypto.subtle.importKey(
    "raw",
    rawContentKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(input.content.iv),
      additionalData: contentContext(input.conversationId)
    },
    contentKey,
    fromBase64Url(input.content.ciphertext)
  );
  return parseDecryptedMessage(JSON.parse(new TextDecoder().decode(plaintext)) as unknown);
}

async function deriveMessageKey(
  sharedSecret: ArrayBuffer,
  salt: Uint8Array<ArrayBuffer>,
  context: Uint8Array<ArrayBuffer>
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: context },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function encryptionContext(conversationId: string, deviceId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`grogoni-e2ee-v1:${conversationId}:${deviceId}`);
}

function contentContext(conversationId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`grogoni-e2ee-v1:${conversationId}:content`);
}

function publicKeyFromJwk(jwk: JsonWebKey): E2eePublicKey {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("The browser generated an unsupported encryption key.");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true };
}

function parseDecryptedMessage(value: unknown): DecryptedMessage {
  if (!value || typeof value !== "object") throw new Error("Encrypted message is malformed.");
  const record = value as { text?: unknown; attachments?: unknown };
  if (typeof record.text !== "string" || !Array.isArray(record.attachments)) {
    throw new Error("Encrypted message is malformed.");
  }
  return { text: record.text, attachments: record.attachments as ConversationAttachment[] };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open encryption storage."));
  });
}

async function readIdentity(identityKey: string): Promise<E2eeIdentity | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).get(identityKey);
      request.onsuccess = () => resolve((request.result as E2eeIdentity | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Could not read encryption key."));
    });
  } finally {
    database.close();
  }
}

async function writeIdentity(identityKey: string, identity: E2eeIdentity): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(identity, identityKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not store encryption key."));
    });
  } finally {
    database.close();
  }
}
