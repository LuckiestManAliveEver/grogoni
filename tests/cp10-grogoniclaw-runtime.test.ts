import { describe, expect, it } from "vitest";
import {
  createRuntimeToolProposalFromProductContextScript,
  createRuntimeToolProposal,
  parseProductContextScriptCommand,
  parseMerchantCommand,
  runtimeToolRegistry
} from "../packages/tool-core/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { cp10RuntimeEvalCommands } from "./ai-eval/cp10-runtime-commands";

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

interface ProductResponse {
  id: string;
  name: string;
  quantity: number;
}

interface RuntimeTurnResponse {
  session: {
    id: string;
    turnCount: number;
  };
  turn: {
    status: "completed" | "needs_confirmation" | "clarifying" | "blocked" | "rate_limited";
    parserIntent: string;
    context: {
      businessId: string;
      productCount: number;
    };
    plan: {
      toolName: string;
      risk: string;
      requiresConfirmation: boolean;
      confirmationToken: string | null;
      executedAt: string | null;
    };
    verification: {
      ok: boolean;
      requiresConfirmation: boolean;
      confirmationSatisfied: boolean;
      roleAllowed: boolean;
    };
    response: string;
    toolResult: unknown;
    telemetry: Array<{
      state: string;
      metadata: Record<string, unknown>;
    }>;
  };
}

describe("CP10 Grogoniclaw runtime", () => {
  it("keeps a runtime evaluation set mapped to tool proposals and confirmation rules", () => {
    expect(cp10RuntimeEvalCommands.length).toBeGreaterThanOrEqual(12);

    for (const command of cp10RuntimeEvalCommands) {
      const proposal = createRuntimeToolProposal(parseMerchantCommand(command.text));
      const definition = runtimeToolRegistry[proposal.toolName];

      expect(proposal.toolName).toBe(command.expectedTool);
      expect(definition.requiresConfirmation).toBe(command.expectedRequiresConfirmation);
    }
  });

  it("resolves product vocabulary context scripts before model fallback", () => {
    const lookup = parseProductContextScriptCommand({ message: "Show products" });
    expect(lookup).toMatchObject({
      matched: true,
      source: "context_script",
      intent: "PRODUCT_LIST",
      cardinality: "multiple"
    });
    expect(createRuntimeToolProposalFromProductContextScript(lookup!)).toMatchObject({
      toolName: "products.list",
      validation: { ok: true }
    });

    expect(parseProductContextScriptCommand({ message: "Tafuta bidhaa" })).toMatchObject({
      intent: "PRODUCT_LIST"
    });
    expect(parseProductContextScriptCommand({ message: "stock iko aje" })).toMatchObject({
      intent: "PRODUCT_LIST",
      cardinality: "single"
    });
    expect(parseProductContextScriptCommand({ message: "Add product maize flour" })).toMatchObject({
      intent: "PRODUCT_ADD",
      cardinality: "single",
      entities: {
        productName: "maize flour"
      }
    });
    expect(parseProductContextScriptCommand({ message: "Ongeza bidhaa tatu" })).toMatchObject({
      intent: "PRODUCT_ADD"
    });
    expect(parseProductContextScriptCommand({ message: "Edit maize flour" })).toMatchObject({
      intent: "PRODUCT_EDIT",
      entities: {
        productName: "maize flour"
      }
    });
    expect(parseProductContextScriptCommand({ message: "Badilisha bidhaa" })).toMatchObject({
      intent: "PRODUCT_EDIT"
    });
    expect(parseProductContextScriptCommand({ message: "Delete these products" })).toMatchObject({
      intent: "PRODUCT_DELETE",
      cardinality: "multiple",
      requiresConfirmation: true,
      clarificationRequired: true
    });
    expect(parseProductContextScriptCommand({ message: "Usifute bidhaa" })).toBeNull();
    expect(
      parseProductContextScriptCommand({ message: "Remove product field expiry date" })
    ).toMatchObject({
      intent: "PRODUCT_FIELD_REMOVE",
      entity: "product_field",
      entities: {
        fieldName: "expiry date"
      }
    });
    expect(
      parseProductContextScriptCommand({ message: "Tell me how products are performing" })
    ).toBeNull();

    expect(
      parseProductContextScriptCommand({
        message: "show dishes",
        tenantId: "restaurant",
        contextScripts: ["# Restaurant catalogue\n\n- show dishes => show products"]
      })
    ).toMatchObject({
      intent: "PRODUCT_LIST",
      matchedPhrase: "show dishes"
    });
  });

  it("executes safe read tools through a business-scoped runtime turn", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Sugar",
        unit: "kg",
        quantity: 4
      },
      sessionCookie
    );

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "show products"
      },
      sessionCookie
    );

    expect(turn.turn).toMatchObject({
      status: "completed",
      parserIntent: "show_products",
      plan: {
        toolName: "products.list",
        risk: "low",
        requiresConfirmation: false,
        confirmationToken: null
      },
      verification: {
        ok: true,
        requiresConfirmation: false,
        confirmationSatisfied: false,
        roleAllowed: true
      }
    });
    expect(turn.turn.context).toMatchObject({
      businessId,
      productCount: 1
    });
    expect(turn.turn.toolResult).toEqual([
      expect.objectContaining({
        name: "Sugar"
      })
    ]);
    expect(turn.turn.telemetry.map((event) => event.state)).toEqual(
      expect.arrayContaining([
        "turn.received",
        "context.built",
        "intent.routed",
        "plan.created",
        "verification.completed",
        "tool.executed",
        "response.generated"
      ])
    );
    expect(turn.turn.telemetry.find((event) => event.state === "intent.routed")?.metadata).toEqual(
      expect.objectContaining({
        source: "context_script",
        scriptId: "product-vocabulary",
        canonicalIntent: "PRODUCT_LIST"
      })
    );
    const runtimeEvent = store
      .snapshot()
      .auditEvents.find((event) => event.type === "runtime.turn_recorded");
    expect(JSON.stringify(runtimeEvent?.payload)).not.toContain("show products");

    await app.close();
  });

  it("executes reports.summary and notifications.list as safe read tools through a runtime turn (Phase 4l)", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const reportsTurn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "show reports" },
      sessionCookie
    );
    expect(reportsTurn.turn).toMatchObject({
      status: "completed",
      parserIntent: "show_reports",
      plan: {
        toolName: "reports.summary",
        risk: "low",
        requiresConfirmation: false,
        confirmationToken: null
      }
    });
    expect(reportsTurn.turn.toolResult).toMatchObject({
      businessId
    });

    const notificationsTurn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "show notifications" },
      sessionCookie
    );
    expect(notificationsTurn.turn).toMatchObject({
      status: "completed",
      parserIntent: "show_notifications",
      plan: {
        toolName: "notifications.list",
        risk: "low",
        requiresConfirmation: false,
        confirmationToken: null
      }
    });
    expect(notificationsTurn.turn.toolResult).toMatchObject({
      summary: expect.any(Object),
      notifications: expect.any(Array)
    });

    await app.close();
  });

  it("requires confirmation before high-risk runtime tools can mutate records", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    // product.create is auto-accepted (no confirmation tap - see "auto-accepts product.create
    // and product.stock_adjust" below), so this general "high-risk tools require confirmation"
    // proof uses product.update instead, which still requires it. Create the product first -
    // that step now completes in one call, with no confirmation step of its own.
    await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "add product sugar" },
      sessionCookie
    );
    expect(store.snapshot().products).toHaveLength(1);

    const proposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "update product sugar ksh 200"
      },
      sessionCookie
    );

    expect(proposed.turn).toMatchObject({
      status: "needs_confirmation",
      plan: {
        toolName: "product.update",
        risk: "high",
        requiresConfirmation: true,
        executedAt: null
      },
      verification: {
        ok: false,
        requiresConfirmation: true,
        confirmationSatisfied: false
      }
    });
    expect(proposed.turn.plan.confirmationToken).toBeTruthy();
    expect(store.snapshot().products[0]?.sellingPrice).not.toBe(200);

    const confirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: proposed.session.id,
        message: "confirm",
        confirmationToken: proposed.turn.plan.confirmationToken
      },
      sessionCookie
    );

    expect(confirmed.turn).toMatchObject({
      status: "completed",
      plan: {
        toolName: "product.update",
        risk: "high",
        requiresConfirmation: true
      },
      verification: {
        ok: true,
        confirmationSatisfied: true
      }
    });
    expect(confirmed.turn.plan.executedAt).toBeTruthy();
    expect(confirmed.turn.toolResult).toMatchObject({
      name: "Sugar",
      sellingPrice: 200
    });
    expect(store.snapshot().products.map((product) => product.name)).toEqual(["Sugar"]);

    await app.close();
  });

  it('runs "Add 20 crates of tomatoes at KSh 1,800" through the canonical auto-accepted capability', async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const proposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "Add 20 crates of tomatoes at KSh 1,800" },
      sessionCookie
    );
    // product.create is auto-accepted - completes in this same turn, no confirmation round trip.
    expect(proposed.turn).toMatchObject({
      status: "completed",
      parserIntent: "add_product",
      plan: { toolName: "product.create", requiresConfirmation: false }
    });
    expect(proposed.turn.plan.confirmationToken).toBeNull();
    expect(proposed.turn.toolResult).toMatchObject({
      name: "Tomatoes",
      unit: "crates",
      quantity: 20,
      sellingPrice: 1800
    });
    expect(store.snapshot().products).toEqual([
      expect.objectContaining({
        name: "Tomatoes",
        unit: "crates",
        quantity: 20,
        sellingPrice: 1800
      })
    ]);

    await app.close();
  });

  it('answers "Who owes me money?" through the authorized customer-debt capability', async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const customer = await postJson<{ id: string }>(
      app,
      `/businesses/${businessId}/customers`,
      { name: "Amina" },
      sessionCookie
    );
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      { name: "Rice", unit: "kg", quantity: 5 },
      sessionCookie
    );
    const invoice = await postJson<{ id: string }>(
      app,
      `/businesses/${businessId}/invoices`,
      { customerId: customer.id, items: [{ productId: product.id, quantity: 2, unitPrice: 100 }] },
      sessionCookie
    );
    await postJson(
      app,
      `/businesses/${businessId}/invoices/${invoice.id}/confirm`,
      {},
      sessionCookie
    );

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "Who owes me money?" },
      sessionCookie
    );
    expect(turn.turn).toMatchObject({
      status: "completed",
      parserIntent: "check_debt",
      plan: { toolName: "payments.debtors", requiresConfirmation: false },
      verification: { ok: true, roleAllowed: true },
      toolResult: [{ customerName: "Amina", invoiceCount: 1, totalInvoiced: 200, balanceDue: 200 }]
    });

    await app.close();
  });

  it("creates, edits, and adjusts stock for a product through confirmed runtime turns (Phase 4a)", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    // product.create is auto-accepted - completes in this same turn, no confirmation round trip.
    const createProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "add product sugar ksh 150" },
      sessionCookie
    );
    expect(createProposed.turn.plan).toMatchObject({
      toolName: "product.create",
      requiresConfirmation: false
    });
    // The tool proposal's price came from a currency-tagged number, not the bare-quantity slot -
    // this is the exact case the parser's double-counting fix (Phase 4a) exists to prevent.
    expect(createProposed.turn.toolResult).toMatchObject({
      name: "Sugar",
      quantity: 0,
      sellingPrice: 150
    });

    const editProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { runtimeSessionId: createProposed.session.id, message: "update product sugar ksh 200" },
      sessionCookie
    );
    expect(editProposed.turn.plan).toMatchObject({
      toolName: "product.update",
      requiresConfirmation: true
    });
    const editConfirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "confirm",
        confirmationToken: editProposed.turn.plan.confirmationToken
      },
      sessionCookie
    );
    expect(editConfirmed.turn.toolResult).toMatchObject({
      name: "Sugar",
      sellingPrice: 200,
      quantity: 0
    });

    // product.stock_adjust is auto-accepted - completes in this same turn, no confirmation round
    // trip.
    const stockProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { runtimeSessionId: createProposed.session.id, message: "adjust stock sugar 40" },
      sessionCookie
    );
    expect(stockProposed.turn.plan).toMatchObject({
      toolName: "product.stock_adjust",
      requiresConfirmation: false
    });
    expect(stockProposed.turn.toolResult).toMatchObject({
      product: { name: "Sugar", quantity: 40 }
    });

    const finalProducts = store.snapshot().products;
    expect(finalProducts).toHaveLength(1);
    expect(finalProducts[0]).toMatchObject({ name: "Sugar", quantity: 40, sellingPrice: 200 });

    await app.close();
  });

  it("creates and edits a supplier through confirmed runtime turns, not the product vocabulary (Phase 4b)", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const createProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "add supplier John Doe 0712345678" },
      sessionCookie
    );
    // The prior draft of this phase would have this misrouted through the product vocabulary
    // matcher (a bare "edit"/"update" verb alone was enough to match PRODUCT_EDIT) - asserting the
    // parser intent here is the guard against that regression coming back.
    expect(createProposed.turn).toMatchObject({
      parserIntent: "add_supplier",
      plan: { toolName: "supplier.create" }
    });
    const createConfirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "confirm",
        confirmationToken: createProposed.turn.plan.confirmationToken
      },
      sessionCookie
    );
    expect(createConfirmed.turn.toolResult).toMatchObject({
      name: "John Doe",
      phone: "0712345678"
    });

    const editProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "edit supplier John Doe 0798765432"
      },
      sessionCookie
    );
    expect(editProposed.turn).toMatchObject({
      parserIntent: "update_supplier",
      plan: { toolName: "supplier.update" }
    });
    const editConfirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "confirm",
        confirmationToken: editProposed.turn.plan.confirmationToken
      },
      sessionCookie
    );
    expect(editConfirmed.turn.toolResult).toMatchObject({
      name: "John Doe",
      phone: "0798765432"
    });

    const finalSuppliers = store.snapshot().suppliers;
    expect(finalSuppliers).toHaveLength(1);
    expect(finalSuppliers[0]).toMatchObject({ name: "John Doe", phone: "0798765432" });
    // Confirms the product vocabulary's bare "edit" phrase never fired a phantom product.update -
    // the supplier flow above must not have created or touched any product record.
    expect(store.snapshot().products).toHaveLength(0);

    await app.close();
  });

  it("creates and edits a customer through confirmed runtime turns, not the product vocabulary (Phase 4c)", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const createProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "add customer Mary Wanjiru 0722334455" },
      sessionCookie
    );
    expect(createProposed.turn).toMatchObject({
      parserIntent: "add_customer",
      plan: { toolName: "customer.create" }
    });
    const createConfirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "confirm",
        confirmationToken: createProposed.turn.plan.confirmationToken
      },
      sessionCookie
    );
    expect(createConfirmed.turn.toolResult).toMatchObject({
      name: "Mary Wanjiru",
      phone: "0722334455"
    });

    const editProposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "edit customer Mary Wanjiru 0700111222"
      },
      sessionCookie
    );
    expect(editProposed.turn).toMatchObject({
      parserIntent: "update_customer",
      plan: { toolName: "customer.update" }
    });
    const editConfirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: createProposed.session.id,
        message: "confirm",
        confirmationToken: editProposed.turn.plan.confirmationToken
      },
      sessionCookie
    );
    expect(editConfirmed.turn.toolResult).toMatchObject({
      name: "Mary Wanjiru",
      phone: "0700111222"
    });

    const finalCustomers = store.snapshot().customers;
    expect(finalCustomers).toHaveLength(1);
    expect(finalCustomers[0]).toMatchObject({ name: "Mary Wanjiru", phone: "0700111222" });
    // Confirms the product vocabulary's bare "edit" phrase never fired a phantom product.update.
    expect(store.snapshot().products).toHaveLength(0);

    await app.close();
  });

  it("classifies create_invoice and surfaces the extracted customer name for the composer card (Phase 4d)", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      { message: "create invoice for Mary" },
      sessionCookie
    );
    // Free text alone can never fully specify an invoice (product + quantity + price) - this
    // asserts the proposal stays a non-executable draft signal that only carries the customer
    // name, which is exactly what the frontend reads to open the invoice composer card instead of
    // attempting to create anything from the message.
    expect(turn.turn).toMatchObject({
      status: "clarifying",
      parserIntent: "create_invoice",
      plan: {
        toolName: "invoice.draft",
        executedAt: null,
        input: { customerName: "Mary" }
      }
    });
    expect(store.snapshot().invoices).toHaveLength(0);

    await app.close();
  });

  it("keeps incomplete runtime mutations as clarifications without writing payments", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "record payment KES 500 from Mary"
      },
      sessionCookie
    );

    expect(turn.turn).toMatchObject({
      status: "clarifying",
      parserIntent: "record_payment",
      plan: {
        toolName: "payment.record",
        requiresConfirmation: true,
        confirmationToken: null,
        // Pins the contract the Phase 4e frontend trigger depends on: the extracted customer name
        // stays available on the plan even though the proposal itself is never executable from
        // free text alone (a customer can have several open invoices) - see
        // PaymentManagementCard.tsx and docs/frontend/frontend.md Phase 4e.
        input: { customerName: "Mary", amount: 500 }
      }
    });
    expect(turn.turn.plan.executedAt).toBeNull();
    expect(store.snapshot().payments).toHaveLength(0);

    await app.close();
  });

  it("keeps incomplete logistics status updates as clarifications without writing changes (Phase 4h)", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "mark delivered for Mary"
      },
      sessionCookie
    );

    expect(turn.turn).toMatchObject({
      status: "clarifying",
      parserIntent: "update_logistics",
      plan: {
        toolName: "logistics.update_status",
        requiresConfirmation: true,
        confirmationToken: null,
        // Pins the contract the Phase 4h frontend trigger depends on: the extracted customer name
        // stays available on the plan even though the proposal itself is never executable from
        // free text alone (a customer can have several open deliveries, and no status is stated) -
        // see LogisticsManagementCard.tsx and docs/frontend/frontend.md Phase 4h.
        input: { customerName: "Mary" }
      }
    });
    expect(turn.turn.plan.executedAt).toBeNull();

    await app.close();
  });

  it("does not leak runtime context or read results across businesses", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId: firstBusinessId, sessionCookie: firstSessionCookie } =
      await createOwnerBusiness(app);
    const { businessId: secondBusinessId, sessionCookie: secondSessionCookie } =
      await createOwnerBusiness(app, {
        contact: "254700000010",
        businessName: "Second Shop"
      });
    await postJson<ProductResponse>(
      app,
      `/businesses/${firstBusinessId}/products`,
      {
        name: "Hidden Stock",
        unit: "unit",
        quantity: 2
      },
      firstSessionCookie
    );

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${secondBusinessId}/runtime/turns`,
      {
        message: "show products"
      },
      secondSessionCookie
    );

    expect(turn.turn.context).toMatchObject({
      businessId: secondBusinessId,
      productCount: 0
    });
    expect(turn.turn.toolResult).toEqual([]);

    await app.close();
  });

  it("lists runtime sessions and turns and rate-limits long-running sessions", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    let runtimeSessionId: string | null = null;
    let finalTurn: RuntimeTurnResponse | null = null;

    for (let index = 0; index < 21; index += 1) {
      finalTurn = await postJson<RuntimeTurnResponse>(
        app,
        `/businesses/${businessId}/runtime/turns`,
        {
          ...(runtimeSessionId === null ? {} : { runtimeSessionId }),
          message: "show products"
        },
        sessionCookie
      );
      runtimeSessionId = finalTurn.session.id;
    }

    expect(finalTurn?.turn.status).toBe("rate_limited");
    expect(finalTurn?.turn.verification.rateLimited).toBe(true);

    const sessions = await getJson<Array<{ id: string; turnCount: number }>>(
      app,
      `/businesses/${businessId}/runtime/sessions`,
      sessionCookie
    );
    const turns = await getJson<Array<{ id: string; status: string }>>(
      app,
      `/businesses/${businessId}/runtime/sessions/${runtimeSessionId}/turns`,
      sessionCookie
    );

    expect(sessions).toEqual([
      expect.objectContaining({
        id: runtimeSessionId,
        turnCount: 21
      })
    ]);
    expect(turns).toHaveLength(21);
    expect(turns.at(-1)).toMatchObject({
      status: "rate_limited"
    });

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  options: { contact?: string; businessName?: string } = {}
) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: options.contact ?? "254700000009",
      pin: "1234"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const auth = verifyResponse.json<VerifyOtpResponse>();
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: options.businessName ?? "Jane's Shop",
      language: "en"
    },
    sessionCookie
  );

  expect(auth.session.id).toBeTruthy();

  return {
    businessId: business.business.id,
    sessionCookie
  };
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: Record<string, unknown>,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: cookie === undefined ? jsonHeaders() : { ...jsonHeaders(), cookie },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBe(200);
  return response.json<TResponse>();
}

async function getJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: cookie === undefined ? undefined : { cookie }
  });

  expect(response.statusCode).toBe(200);
  return response.json<TResponse>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toBeDefined();
  return value?.split(";")[0] ?? "";
}
