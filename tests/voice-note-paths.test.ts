import { createHash } from "node:crypto";
import { createMemoryConversationAttachmentBlobStore } from "../services/api/src/cp2/conversation-attachment-blob-store";
import { describe, expect, it, vi } from "vitest";
import { encryptDirectMessage } from "../apps/web/src/e2ee";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { createCp2Store } from "../services/api/src/cp2/store";

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 16000);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(16000, 40);
  return bytes;
}

function fixture(
  transcriber = vi.fn(async () => ({ text: "queued spoken words", model: "fixture" }))
) {
  const requests: string[] = [];
  const provider: RuntimeModelProvider = {
    name: "fixture",
    complete: async (request) => {
      requests.push(JSON.stringify(request));
      return {
        provider: "fixture",
        status: "available",
        outputText: JSON.stringify({ type: "response", message: "Noted." }),
        durationMs: 1,
        errorCode: null,
        metadata: {}
      };
    }
  };
  const blobs = createMemoryConversationAttachmentBlobStore();
  const store = createCp2Store({
    runtimeModelProvider: provider,
    voiceTranscriber: transcriber,
    conversationAttachmentBlobStore: blobs
  });
  const owner = store.continueWithChannelPin({
    channel: "email",
    destination: "voice-path@example.invalid",
    pin: "3927"
  });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name: "Voice paths",
    language: "en",
    phoneNumber: "+254711456781",
    phoneCountry: "KE"
  }).business;
  const conversation = store.createConversation({
    sessionId: owner.session.id,
    kind: "personal",
    activeShopId: business.id
  }).conversation;
  const bytes = wav();
  const input = {
    sessionId: owner.session.id,
    businessId: business.id,
    conversationId: conversation.id,
    clientMessageId: "voice-path",
    message: "Please listen",
    content: {
      type: "text" as const,
      text: "Please listen",
      attachments: [
        {
          id: "voice",
          name: "note.wav",
          mimeType: "audio/wav",
          size: bytes.length,
          category: "audio" as const,
          url: `data:audio/wav;base64,${bytes.toString("base64")}`
        }
      ]
    }
  };
  return { store, owner, business, conversation, input, transcriber, requests, blobs };
}

describe("voice note execution paths", () => {
  it("carries attachment evidence through the queued worker", async () => {
    const f = fixture();
    let queued:
      Parameters<Parameters<typeof f.store.setAgentTurnQueue>[0]["enqueue"]>[0] | undefined;
    f.store.setAgentTurnQueue({
      find: async () => null,
      enqueue: async (request) => {
        queued = request;
        return { id: "turn", status: "pending" };
      },
      settle: async () => {}
    });
    const pending = await f.store.createAgentConversationMessage(f.input);
    expect(pending.processing.status).toBe("pending");
    expect(f.transcriber).not.toHaveBeenCalled();
    expect(queued).toBeDefined();
    await f.store.createAgentConversationMessage({
      ...f.input,
      ...(queued!.request as typeof f.input),
      runQueuedTurn: true
    });
    expect(f.transcriber).toHaveBeenCalledOnce();
    expect(f.requests.join("\n")).toContain("queued spoken words");
    expect(f.requests.join("\n")).toContain("Untrusted attachment observations");
  });

  it("sends evidence to the model when the fixed voice prompt matches a context script", async () => {
    const f = fixture();
    const current = f.store.getAgentProfile({
      sessionId: f.owner.session.id,
      businessId: f.business.id
    });
    f.store.updateAgentProfile({
      sessionId: f.owner.session.id,
      businessId: f.business.id,
      profile: {
        ...current,
        contextScripts: [
          "script: product_catalogue_commands\nallow: read, add, edit, remove\nen: Please consider the attached voice note. => products.list"
        ]
      }
    });
    const result = await f.store.createAgentConversationMessage(f.input);
    expect(f.requests.join("\n")).toContain("queued spoken words");
    expect(f.requests.join("\n")).toContain("Untrusted attachment observations");
    expect(result.runtime?.turn.toolResult).toBeNull();
  });

  it("transcribes an authorized managed attachment and passes its evidence to the agent", async () => {
    const f = fixture();
    const bytes = wav();
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const record = {
      id: "managed-voice",
      accountId: f.owner.account.id,
      userId: f.owner.user.id,
      businessId: f.business.id,
      conversationId: f.conversation.id,
      messageId: null,
      toolCallId: "fixture",
      filename: "note.wav",
      mimeType: "audio/wav",
      size: bytes.length,
      kind: "file" as const,
      previewable: false,
      caption: null,
      checksum,
      storageKey: "conversation-attachments/managed-voice",
      createdAt: new Date().toISOString()
    };
    await f.blobs.put({
      storageKey: record.storageKey,
      bytes,
      checksum,
      mimeType: record.mimeType
    });
    const snapshot = f.store.snapshot();
    snapshot.conversationAttachments.push(record);
    f.store.hydrateSnapshot(snapshot);
    const attachment = {
      id: record.id,
      name: record.filename,
      mimeType: record.mimeType,
      size: record.size,
      category: "audio" as const,
      source: "managed" as const,
      kind: record.kind,
      previewable: false
    };
    await f.store.createAgentConversationMessage({
      ...f.input,
      content: { type: "text", text: "Please listen", attachments: [attachment] }
    });
    expect(f.transcriber).toHaveBeenCalledOnce();
    expect(f.requests.join("\n")).toContain("queued spoken words");
    expect(f.requests.join("\n")).toContain("Untrusted attachment observations");
  });

  it("does not start a model turn after access is revoked during transcription", async () => {
    let release!: (value: { text: string; model: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transcriber = vi.fn(() => {
      entered();
      return new Promise<{ text: string; model: string }>((resolve) => {
        release = resolve;
      });
    });
    const f = fixture(transcriber);
    const turn = f.store.createAgentConversationMessage(f.input);
    await started;
    f.store.logout(f.owner.session.id);
    release({ text: "private words", model: "fixture" });
    await expect(turn).rejects.toBeDefined();
    expect(f.requests).toHaveLength(0);
  });

  it("never transcribes an encrypted person-to-person audio message", async () => {
    const f = fixture();
    const other = f.store.continueWithChannelPin({
      channel: "email",
      destination: "voice-other@example.invalid",
      pin: "3927"
    });
    const direct = f.store.createConversation({
      sessionId: f.owner.session.id,
      kind: "personal",
      activeShopId: null,
      recipient: other.account.primaryAuthDestination
    }).conversation;
    for (const actor of [f.owner, other]) {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits"
      ]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      f.store.registerE2eeDevice({
        sessionId: actor.session.id,
        deviceId: `device-${crypto.randomUUID()}`,
        label: "fixture",
        publicKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, ext: true }
      });
    }
    const content = await encryptDirectMessage({
      conversationId: direct.id,
      devices: f.store.listConversationE2eeDevices({
        sessionId: f.owner.session.id,
        conversationId: direct.id
      }),
      message: { text: "voice", attachments: f.input.content.attachments }
    });
    f.store.createConversationMessage({
      sessionId: f.owner.session.id,
      conversationId: direct.id,
      clientMessageId: "encrypted-voice",
      content
    });
    await expect(
      f.store.createAgentConversationMessage({
        ...f.input,
        conversationId: direct.id,
        clientMessageId: "encrypted-agent",
        content
      })
    ).rejects.toMatchObject({ code: "agent_processing_requires_agent_conversation" });
    expect(f.transcriber).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });
});
