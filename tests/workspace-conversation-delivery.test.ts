import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConversationAttachment,
  ConversationMessageSummary,
  ConversationView,
  RuntimeTurnResult
} from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import type { ConversationAttachmentBlobStore } from "../services/api/src/cp2/conversation-attachment-blob-store";
import { createCp2Store } from "../services/api/src/cp2/store";
import { activateGenericGlobalDefaultModel } from "./fixtures/native-runtime-test-helpers";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("workspace.deliver conversation integration", () => {
  it("delivers multiple files as cards in one assistant turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grogoni-conversation-batch-"));
    temporaryRoots.push(workspaceRoot);
    const store = createCp2Store({ workspaceRoot, workspaceDeliveryMaxFileBytes: 1_000_000 });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const cookie = await createAccountSession(app, "254700000900");
    const business = await createBusiness(app, cookie, "Workspace Batch Shop");
    const businessWorkspace = join(workspaceRoot, business.id);
    await mkdir(businessWorkspace, { recursive: true });
    await writeFile(join(businessWorkspace, "one.txt"), "one");
    await writeFile(join(businessWorkspace, "two.pdf"), "%PDF-1.7\ntwo");
    const conversationId = await personalConversationId(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        businessId: business.id,
        conversationId,
        clientMessageId: "workspace-batch-0001",
        content: {
          type: "text",
          text: "Please deliver both generated files."
        },
        agent: {
          businessId: business.id,
          message: '#workspace.deliver {"path":"one.txt","additionalPaths":["two.pdf"]}'
        }
      })
    });

    expect(response.statusCode).toBe(200);
    const delivered = response.json<DeliveredMessage>();
    expect(delivered.agentMessage.content).toMatchObject({
      type: "text",
      text: "Here are 2 files."
    });
    expect(
      delivered.agentMessage.content.type === "text"
        ? delivered.agentMessage.content.attachments?.map((attachment) => attachment.name)
        : []
    ).toEqual(["one.txt", "two.pdf"]);
    expect(store.snapshot().conversationAttachments).toHaveLength(2);

    const partialFailure = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "workspace-batch-failure-0001",
        content: { type: "text", text: "Try an incomplete file set." },
        agent: {
          businessId: business.id,
          message: '#workspace.deliver {"path":"one.txt","additionalPaths":["missing.pdf"]}'
        }
      })
    });
    expect(partialFailure.statusCode).toBe(404);
    expect(partialFailure.json()).toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(store.snapshot().conversationAttachments).toHaveLength(2);

    await app.close();
  });

  it("persists PNG, PDF, and XLSX cards and serves authorized preview/download bytes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grogoni-conversation-workspaces-"));
    temporaryRoots.push(workspaceRoot);
    const store = createCp2Store({ workspaceRoot, workspaceDeliveryMaxFileBytes: 1_000_000 });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const ownerCookie = await createAccountSession(app, "254700000901");
    const business = await createBusiness(app, ownerCookie, "Workspace Cards Shop");
    const businessWorkspace = join(workspaceRoot, business.id);
    await mkdir(join(businessWorkspace, "generated"), { recursive: true });
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const pdf = Buffer.from("%PDF-1.7\nGrogoni report\n");
    const xlsx = Buffer.from("504b03040000536f6b6f", "hex");
    await writeFile(join(businessWorkspace, "generated", "catalogue.png"), png);
    await writeFile(join(businessWorkspace, "generated", "sales-report.pdf"), pdf);
    await writeFile(join(businessWorkspace, "generated", "inventory.xlsx"), xlsx);

    const conversationId = await personalConversationId(app, ownerCookie);
    const imageDelivery = await deliverWorkspacePath({
      app,
      cookie: ownerCookie,
      businessId: business.id,
      conversationId,
      clientMessageId: "workspace-image-0001",
      path: "generated/catalogue.png"
    });
    const pdfDelivery = await deliverWorkspacePath({
      app,
      cookie: ownerCookie,
      businessId: business.id,
      conversationId,
      clientMessageId: "workspace-pdf-0001",
      path: "workspace/generated/sales-report.pdf",
      caption: "August sales report"
    });
    const xlsxDelivery = await deliverWorkspacePath({
      app,
      cookie: ownerCookie,
      businessId: business.id,
      conversationId,
      clientMessageId: "workspace-xlsx-0001",
      path: "generated/inventory.xlsx"
    });

    expect(managedAttachment(imageDelivery)).toMatchObject({
      name: "catalogue.png",
      mimeType: "image/png",
      kind: "image",
      previewable: true,
      source: "managed"
    });
    expect(managedAttachment(pdfDelivery)).toMatchObject({
      name: "sales-report.pdf",
      kind: "pdf",
      caption: "August sales report",
      previewable: true
    });
    expect(managedAttachment(xlsxDelivery)).toMatchObject({
      name: "inventory.xlsx",
      kind: "document",
      previewable: false
    });
    expect(JSON.stringify(imageDelivery.agentMessage.content)).not.toContain(workspaceRoot);
    expect(JSON.stringify(imageDelivery.agentMessage.content)).not.toContain(
      "generated/catalogue.png"
    );

    const refreshed = await getJson<ConversationView>(
      app,
      `/v1/conversations/${conversationId}`,
      ownerCookie
    );
    const deliveredCards = refreshed.messages.flatMap((message) =>
      message.content.type === "text" ? (message.content.attachments ?? []) : []
    );
    expect(deliveredCards.map((attachment) => attachment.name)).toEqual(
      expect.arrayContaining(["catalogue.png", "sales-report.pdf", "inventory.xlsx"])
    );
    expect(deliveredCards.every((attachment) => attachment.url === undefined)).toBe(true);

    const imageAttachment = managedAttachment(imageDelivery);
    const preview = await app.inject({
      method: "GET",
      url: attachmentUrl(conversationId, imageAttachment.id, "preview"),
      headers: { cookie: ownerCookie }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("image/png");
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.rawPayload).toEqual(png);

    const pdfAttachment = managedAttachment(pdfDelivery);
    const pdfDownload = await app.inject({
      method: "GET",
      url: attachmentUrl(conversationId, pdfAttachment.id, "download"),
      headers: { cookie: ownerCookie }
    });
    expect(pdfDownload.statusCode).toBe(200);
    expect(pdfDownload.headers["content-disposition"]).toContain("attachment");
    expect(pdfDownload.rawPayload).toEqual(pdf);

    const xlsxAttachment = managedAttachment(xlsxDelivery);
    const unavailablePreview = await app.inject({
      method: "GET",
      url: attachmentUrl(conversationId, xlsxAttachment.id, "preview"),
      headers: { cookie: ownerCookie }
    });
    expect(unavailablePreview.statusCode).toBe(415);
    expect(unavailablePreview.json()).toMatchObject({ code: "ATTACHMENT_PREVIEW_UNAVAILABLE" });

    const otherCookie = await createAccountSession(app, "254700000902");
    const forbidden = await app.inject({
      method: "GET",
      url: attachmentUrl(conversationId, imageAttachment.id, "download"),
      headers: { cookie: otherCookie }
    });
    expect(forbidden.statusCode).toBe(404);
    const altered = await app.inject({
      method: "GET",
      url: attachmentUrl(conversationId, "00000000-0000-4000-8000-000000000000", "download"),
      headers: { cookie: ownerCookie }
    });
    expect(altered.statusCode).toBe(404);

    await app.close();
  });

  it("does not let a client fabricate a managed attachment and deduplicates a retried agent message", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grogoni-conversation-workspaces-"));
    temporaryRoots.push(workspaceRoot);
    const store = createCp2Store({ workspaceRoot });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const cookie = await createAccountSession(app, "254700000903");
    const business = await createBusiness(app, cookie, "Retry Cards Shop");
    await mkdir(join(workspaceRoot, business.id), { recursive: true });
    await writeFile(join(workspaceRoot, business.id, "note.txt"), "Durable note");
    const conversationId = await personalConversationId(app, cookie);

    const first = await deliverWorkspacePath({
      app,
      cookie,
      businessId: business.id,
      conversationId,
      clientMessageId: "workspace-retry-0001",
      path: "note.txt"
    });
    const retried = await deliverWorkspacePath({
      app,
      cookie,
      businessId: business.id,
      conversationId,
      clientMessageId: "workspace-retry-0001",
      path: "note.txt"
    });
    expect(retried.agentMessage.id).toBe(first.agentMessage.id);
    expect(store.snapshot().conversationAttachments).toHaveLength(1);

    const fabricated = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "fake-managed-attachment-0001",
        content: {
          type: "text",
          text: "fake",
          attachments: [
            {
              id: "att_fake",
              name: "fake.pdf",
              mimeType: "application/pdf",
              size: 10,
              category: "document",
              source: "managed",
              kind: "pdf",
              previewable: true
            }
          ]
        }
      })
    });
    expect(fabricated.statusCode).toBe(400);
    expect(fabricated.json()).toMatchObject({ code: "ATTACHMENT_INVALID" });

    await app.close();
  });

  it("rolls back every stored blob when a batch storage write fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grogoni-conversation-storage-"));
    temporaryRoots.push(workspaceRoot);
    const blobs = new Map<string, Buffer>();
    let writes = 0;
    const blobStore: ConversationAttachmentBlobStore = {
      async put(blob) {
        writes += 1;
        if (writes === 2) throw new Error("simulated storage failure");
        blobs.set(blob.storageKey, Buffer.from(blob.bytes));
      },
      async get(storageKey) {
        return blobs.get(storageKey) ?? null;
      },
      async delete(storageKey) {
        blobs.delete(storageKey);
      }
    };
    const store = createCp2Store({
      workspaceRoot,
      conversationAttachmentBlobStore: blobStore
    });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const cookie = await createAccountSession(app, "254700000904");
    const business = await createBusiness(app, cookie, "Atomic Storage Shop");
    await mkdir(join(workspaceRoot, business.id), { recursive: true });
    await writeFile(join(workspaceRoot, business.id, "one.txt"), "one");
    await writeFile(join(workspaceRoot, business.id, "two.txt"), "two");
    const conversationId = await personalConversationId(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "workspace-storage-failure-0001",
        content: { type: "text", text: "Deliver both files." },
        agent: {
          businessId: business.id,
          message: '#workspace.deliver {"path":"one.txt","additionalPaths":["two.txt"]}'
        }
      })
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "STORAGE_FAILED" });
    expect(store.snapshot().conversationAttachments).toHaveLength(0);
    expect(blobs.size).toBe(0);
    await app.close();
  });
});

interface DeliveredMessage extends ConversationMessageSummary {
  agentMessage: ConversationMessageSummary;
  runtime: RuntimeTurnResult;
}

async function deliverWorkspacePath(input: {
  app: ReturnType<typeof buildApi>;
  cookie: string;
  businessId: string;
  conversationId: string;
  clientMessageId: string;
  path: string;
  caption?: string;
}): Promise<DeliveredMessage> {
  return postJson<DeliveredMessage>(
    input.app,
    "/v1/messages",
    {
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      content: { type: "text", text: "Please deliver the generated file." },
      agent: {
        businessId: input.businessId,
        message: `#workspace.deliver ${JSON.stringify({
          path: input.path,
          ...(input.caption === undefined ? {} : { caption: input.caption })
        })}`
      }
    },
    input.cookie
  );
}

function managedAttachment(delivery: DeliveredMessage): ConversationAttachment {
  if (delivery.agentMessage.content.type !== "text") throw new Error("Expected text message.");
  const attachment = delivery.agentMessage.content.attachments?.[0];
  if (attachment === undefined) throw new Error("Expected managed attachment.");
  return attachment;
}

function attachmentUrl(
  conversationId: string,
  attachmentId: string,
  action: "preview" | "download"
): string {
  return `/v1/conversations/${conversationId}/attachments/${attachmentId}/${action}`;
}

async function personalConversationId(
  app: ReturnType<typeof buildApi>,
  cookie: string
): Promise<string> {
  const response = await getJson<{ conversations: Array<{ id: string }> }>(
    app,
    "/v1/conversations",
    cookie
  );
  const conversation = response.conversations[0];
  if (conversation === undefined) throw new Error("Personal conversation missing.");
  return conversation.id;
}

async function createAccountSession(
  app: ReturnType<typeof buildApi>,
  destination: string
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  const value = response.headers["set-cookie"];
  const cookie = Array.isArray(value) ? value[0] : value;
  if (cookie === undefined) throw new Error("Session cookie missing.");
  return cookie.split(";", 1)[0] ?? cookie;
}

async function createBusiness(
  app: ReturnType<typeof buildApi>,
  cookie: string,
  name: string
): Promise<{ id: string }> {
  const response = await postJson<{ business: { id: string } }>(
    app,
    "/businesses",
    { name, language: "en" },
    cookie
  );
  return response.business;
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
