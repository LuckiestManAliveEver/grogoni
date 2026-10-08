import { describe, expect, it } from "vitest";
import {
  createRuntimeToolProposalFromReceiptContextScript,
  parseReceiptContextScriptCommand
} from "../packages/tool-core/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface VerifyOtpResponse {
  session: {
    id: string;
  };
}

interface CreateBusinessResponse {
  business: {
    id: string;
  };
}

interface SupplierResponse {
  id: string;
  name: string;
}

interface SalesAgentResponse {
  id: string;
  supplierId: string;
  name: string;
}

interface NetworkGraphResponse {
  nodes: Array<{
    id: string;
    displayName: string;
  }>;
}

interface ReceiptOCRJobResponse {
  id: string;
  status: string;
  engine: string;
  profile: string;
  fallbackUsed: boolean;
  blocks: Array<{ text: string; confidence: number }>;
  fullText: string;
  averageConfidence: number;
  fieldEvidence: Array<{ field: string; value: string | number | null }>;
  supplierCandidates: Array<{
    id: string;
    name: string;
    confidence: number;
    matchedBy: string[];
    sources: string[];
    requiresConfirmation: boolean;
    contactId: string | null;
    recordId: string | null;
  }>;
  salesAgentCandidates: Array<{
    id: string;
    name: string;
    confidence: number;
    matchedBy: string[];
    sources: string[];
    requiresConfirmation: boolean;
    contactId: string | null;
    recordId: string | null;
  }>;
  structuredExtraction: {
    supplier: {
      supplierName: string | null;
      phoneNumber: string | null;
      email: string | null;
      taxPin: string | null;
    };
    receipt: {
      receiptNumber: string | null;
      currency: string | null;
      total: number | null;
    };
  };
  contactMatchingResult: {
    scriptId: "receipt_contact_matching";
    intent: "RECEIPT_CONTACT_MATCH";
    supplier: {
      confidence: number;
      matchedBy: string[];
      sources: string[];
      requiresConfirmation: boolean;
      selectedRecordId: string | null;
      selectedContactId: string | null;
    };
    salesAgent: {
      confidence: number;
      matchedBy: string[];
      sources: string[];
      requiresConfirmation: boolean;
      selectedRecordId: string | null;
      selectedContactId: string | null;
    };
    unmatchedFields: string[];
    warnings: string[];
  };
  matchedSupplierId: string | null;
  imageRetained: boolean;
  imageDeletedAt: string | null;
  cleanupPending: boolean;
  warnings: string[];
  items: Array<{ name: string; quantity: number; unitPrice: number; total: number }>;
}

interface PurchaseReceiptResponse {
  id: string;
  supplierName: string;
  imageStored: boolean;
  lineItems: Array<{ name: string; quantity: number; unitPrice: number; total: number }>;
}

interface RuntimeTurnResponse {
  turn: {
    plan: {
      toolName: string;
    };
    telemetry: Array<{
      state: string;
      metadata: Record<string, unknown>;
    }>;
  };
}

describe("Receipt OCR", () => {
  it("refuses binary receipt content: text must come from an agent tool or the client", async () => {
    // The server-side OCR worker was removed with the local-first runtime
    // (docs/local-first-cloud-audit.md), so a receipt job needs already-extracted text.
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const binary = Buffer.from("ffd8ffe000104a464946", "hex");
    const response = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/receipt-ocr/jobs`,
      headers: { "content-type": "application/json", cookie: sessionCookie },
      payload: JSON.stringify({
        fileName: "receipt.jpg",
        contentType: "image/jpeg",
        contentBase64: binary.toString("base64"),
        fileSizeBytes: binary.byteLength
      })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "receipt_text_required" });
    await app.close();
  });

  it("uses PaddleOCR metadata, matches suppliers, saves structured data, and deletes image metadata", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const supplier = await postJson<SupplierResponse>(
      app,
      `/businesses/${businessId}/suppliers`,
      {
        name: "Wholesale Depot",
        phone: "+254700000010",
        email: null,
        notes: null
      },
      sessionCookie
    );

    const job = await postJson<ReceiptOCRJobResponse>(
      app,
      `/businesses/${businessId}/receipt-ocr/jobs`,
      {
        fileName: "receipt.jpg",
        contentType: "image/jpeg",
        fileSizeBytes: 4096,
        fileSignature: "ffd8ffe000104a464946",
        extractedText:
          "Supplier: Wholesale Depot\nAgent: Mary Wanjiku\nPhone: +254700000010\nDate: 2026-07-09\nMaize,2,100,200\nTotal: 200"
      },
      sessionCookie
    );

    expect(job).toMatchObject({
      status: "MATCHING",
      engine: "paddleocr",
      profile: "balanced",
      fallbackUsed: false,
      matchedSupplierId: supplier.id,
      imageRetained: false,
      cleanupPending: false
    });
    expect(job.blocks.length).toBeGreaterThan(0);
    expect(job.fieldEvidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "supplierName" })])
    );
    expect(job.supplierCandidates[0]).toMatchObject({
      name: "Wholesale Depot"
    });
    expect(job.items[0]).toMatchObject({
      name: "Maize",
      quantity: 2,
      unitPrice: 100,
      total: 200
    });

    const receipt = await postJson<PurchaseReceiptResponse>(
      app,
      `/businesses/${businessId}/receipt-ocr/jobs/${job.id}/confirm`,
      {
        supplierId: job.matchedSupplierId,
        createSupplier: false
      },
      sessionCookie
    );

    expect(receipt).toMatchObject({
      supplierName: "Wholesale Depot",
      imageStored: false
    });
    expect(receipt.lineItems).toHaveLength(1);

    const repeatedConfirmation = await postJson<PurchaseReceiptResponse>(
      app,
      `/businesses/${businessId}/receipt-ocr/jobs/${job.id}/confirm`,
      { supplierId: job.matchedSupplierId },
      sessionCookie
    );
    expect(repeatedConfirmation.id).toBe(receipt.id);

    const savedReceipts = await getJson<PurchaseReceiptResponse[]>(
      app,
      `/businesses/${businessId}/purchase-receipts`,
      sessionCookie
    );
    expect(savedReceipts[0]).toMatchObject({
      id: receipt.id,
      imageStored: false
    });
    expect(savedReceipts).toHaveLength(1);
    expect(store.snapshot().receiptOCRJobs[0]).toMatchObject({
      status: "COMPLETED",
      imageRetained: false,
      cleanupPending: false
    });
    expect(store.snapshot().receiptOCRJobs[0]?.imageDeletedAt).toBeNull();

    await app.close();
  });

  it("rejects unsupported or spoofed receipt uploads before OCR", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const response = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/receipt-ocr/jobs`,
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        fileName: "receipt.jpg",
        contentType: "image/jpeg",
        fileSizeBytes: 100,
        fileSignature: "25504446",
        extractedText: "Supplier: Wholesale Depot"
      })
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "receipt_ocr_signature_mismatch"
    });

    await app.close();
  });

  it("runs receipt-contact-matching before model fallback with deterministic contact and supplier resolution", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const graph = await postJson<NetworkGraphResponse>(
      app,
      "/network/sync/contacts",
      {
        contacts: [
          {
            name: "Wholesale Depot Ltd",
            phone: "+254700000010"
          },
          {
            name: "Mary Wanjiku",
            phone: "+254700000011"
          }
        ]
      },
      sessionCookie
    );
    const supplierContactId = graph.nodes.find(
      (node) => node.displayName === "Wholesale Depot Ltd"
    )?.id;
    expect(supplierContactId).toBeTruthy();
    const agentContactId = graph.nodes.find((node) => node.displayName === "Mary Wanjiku")?.id;
    expect(agentContactId).toBeTruthy();
    const supplier = await postJson<SupplierResponse>(
      app,
      `/businesses/${businessId}/suppliers`,
      {
        name: "Wholesale Depot",
        phone: "+254700000010",
        email: "supply@example.com",
        notes: "Tax PIN P051234567A"
      },
      sessionCookie
    );
    await postJson<unknown>(
      app,
      `/businesses/${businessId}/suppliers/${supplier.id}/link-contact`,
      {
        networkNodeId: supplierContactId
      },
      sessionCookie
    );
    const matchingAgent = await postJson<SalesAgentResponse>(
      app,
      `/businesses/${businessId}/suppliers/${supplier.id}/sales-agents`,
      {
        name: "Mary Wanjiku",
        phone: "+254700000011",
        email: null,
        notes: null
      },
      sessionCookie
    );
    await postJson<unknown>(
      app,
      `/businesses/${businessId}/sales-agents/${matchingAgent.id}/link-contact`,
      {
        networkNodeId: agentContactId
      },
      sessionCookie
    );
    const otherSupplier = await postJson<SupplierResponse>(
      app,
      `/businesses/${businessId}/suppliers`,
      {
        name: "Other Depot",
        phone: "+254700000020",
        email: null,
        notes: null
      },
      sessionCookie
    );
    const otherAgent = await postJson<SalesAgentResponse>(
      app,
      `/businesses/${businessId}/suppliers/${otherSupplier.id}/sales-agents`,
      {
        name: "Mary Wanjiku",
        phone: "+254700000021",
        email: null,
        notes: null
      },
      sessionCookie
    );

    const job = await postJson<ReceiptOCRJobResponse>(
      app,
      `/businesses/${businessId}/receipt-ocr/jobs`,
      {
        fileName: "receipt.txt",
        contentType: "text/plain",
        fileSizeBytes: 300,
        fileSignature: "",
        extractedText:
          "Supplier: Wholesale Depot Ltd\nEmail: SUPPLY@example.com\nTax PIN: P051234567A\nAgent: Mary Wanjiku\nAgent Phone: 0700000011\nPhone: 0700000010\nReceipt No: R-100\nCurrency: KES\nDate: 2026-07-09\nMaize,2,100,200\nTotal: 200"
      },
      sessionCookie
    );

    expect(job.structuredExtraction).toMatchObject({
      supplier: {
        phoneNumber: "+254700000010",
        email: "supply@example.com",
        taxPin: "P051234567A"
      },
      receipt: {
        receiptNumber: "R-100",
        currency: "KES",
        total: 200
      }
    });
    expect(job.contactMatchingResult).toMatchObject({
      scriptId: "receipt_contact_matching",
      intent: "RECEIPT_CONTACT_MATCH",
      supplier: {
        selectedRecordId: supplier.id,
        selectedContactId: supplierContactId,
        requiresConfirmation: false
      },
      salesAgent: {
        selectedRecordId: matchingAgent.id,
        selectedContactId: agentContactId
      }
    });
    expect(job.contactMatchingResult.supplier.matchedBy).toEqual(
      expect.arrayContaining([
        "confirmed_contact_link",
        "phone_exact",
        "email_exact",
        "tax_pin_exact"
      ])
    );
    expect(job.contactMatchingResult.salesAgent.matchedBy).toEqual(
      expect.arrayContaining(["confirmed_contact_link", "phone_exact", "name_supplier_combination"])
    );
    expect(job.salesAgentCandidates.map((candidate) => candidate.recordId)).not.toContain(
      otherAgent.id
    );

    await app.close();
  });

  it("routes receipt chat commands through protected context scripts before model fallback", async () => {
    const match = parseReceiptContextScriptCommand({
      message: "Which supplier sold me maize last week?"
    });

    expect(match).toMatchObject({
      scriptId: "receipt_ocr_commands",
      intent: "RECEIPT_LOOKUP",
      entities: {
        itemName: "maize",
        dateRange: "last_week"
      }
    });
    expect(createRuntimeToolProposalFromReceiptContextScript(match!)).toMatchObject({
      toolName: "receipt.lookup",
      validation: {
        ok: true
      }
    });
    expect(
      parseReceiptContextScriptCommand({
        message: "match hii receipt na supplier"
      })
    ).toMatchObject({
      intent: "RECEIPT_CONTACT_MATCH"
    });
    expect(
      createRuntimeToolProposalFromReceiptContextScript(
        parseReceiptContextScriptCommand({
          message: "find this supplier in my phonebook"
        })!
      )
    ).toMatchObject({
      toolName: "receipt.review",
      validation: {
        ok: true
      }
    });

    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "Show purchase receipts"
      },
      sessionCookie
    );

    expect(turn.turn.plan.toolName).toBe("receipt.list");
    expect(turn.turn.telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "intent.routed",
          metadata: expect.objectContaining({
            source: "context_script",
            scriptId: "receipt_ocr_commands"
          })
        })
      ])
    );

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const verified = await postJson<VerifyOtpResponse>(
    app,
    "/auth/pin/signup",
    {
      method: "phone",
      contact: "+254700000099",
      pin: "1234"
    },
    null
  );
  const sessionCookie = `grogoni_session=${verified.session.id}`;
  const created = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "OCR Shop",
      language: "en"
    },
    sessionCookie
  );

  return {
    businessId: created.business.id,
    sessionCookie
  };
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  sessionCookie: string | null
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: sessionCookie === null ? jsonHeaders() : { ...jsonHeaders(), cookie: sessionCookie },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json() as TResponse;
}

async function getJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  sessionCookie: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      ...jsonHeaders(),
      cookie: sessionCookie
    }
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json() as TResponse;
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}
