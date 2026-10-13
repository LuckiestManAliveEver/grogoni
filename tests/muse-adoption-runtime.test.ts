import { describe, expect, it, vi } from "vitest";
import type {
  AgentContextSource,
  RuntimeExperience,
  RuntimeModelProvider,
  RuntimeTurnSummary
} from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import {
  contextRecipeRegistry,
  evaluateGrounding,
  groundingAbstentionMessage,
  resolveAgentContext
} from "../services/api/src/cp2/agent-business-runtime";
import { buildRuntimeReportCard } from "../services/api/src/cp2/domains/agent-runtime/report-card";
import { nextRuntimeExperienceState } from "../services/api/src/cp2/domains/agent-runtime/shared";
import { createCp2Store } from "../services/api/src/cp2/store";
import { Cp2Error } from "../services/api/src/cp2/cp2-error";

function source(overrides: {
  id: string;
  type: AgentContextSource["type"];
  content: string;
  sourceRecordId?: string | null;
  audiences?: AgentContextSource["accessRules"]["audiences"];
}): AgentContextSource {
  const now = "2026-09-01T00:00:00.000Z";
  return {
    id: overrides.id,
    tenantId: "shop-1",
    shopId: "shop-1",
    type: overrides.type,
    title: overrides.id,
    status: "active",
    sensitivity: "internal",
    accessRules: {
      audiences: overrides.audiences ?? ["owner", "staff"],
      requiredPermission: null,
      customerVisible: false
    },
    freshnessTimestamp: now,
    version: 1,
    retrievalMetadata: {
      keywords: overrides.content.toLowerCase().split(/\s+/),
      sourceRecordId: overrides.sourceRecordId ?? null,
      content: overrides.content
    },
    createdAt: now,
    updatedAt: now,
    deletedAt: null
  };
}

describe("contextRecipeRegistry", () => {
  it("every entry's id matches grogoni.<taskType>@<version> and its own taskType/version", () => {
    for (const [intent, recipe] of Object.entries(contextRecipeRegistry)) {
      expect(recipe?.id).toBe(`grogoni.${intent}@${recipe?.version}`);
      expect(recipe?.taskType).toBe(intent);
    }
  });

  it("only read-oriented, evidence-dependent intents require grounding", () => {
    expect(contextRecipeRegistry.show_products?.groundingPolicy).toBe("require_evidence");
    expect(contextRecipeRegistry.check_debt?.groundingPolicy).toBe("require_evidence");
    expect(contextRecipeRegistry.show_invoices?.groundingPolicy).toBe("require_evidence");
    expect(contextRecipeRegistry.show_reports?.groundingPolicy).toBe("require_evidence");
    // Write-oriented intents already have an equivalent, narrower grounding mechanism
    // (findRuntimeUnknownEntityReferenceError) - this registry must not duplicate it.
    expect(contextRecipeRegistry.add_customer?.groundingPolicy).toBe("none");
    expect(contextRecipeRegistry.create_invoice?.groundingPolicy).toBe("none");
  });
});

describe("resolveAgentContext diagnostics", () => {
  it("reports candidate/selected/rejected counts and a token estimate that respects the budget", () => {
    const sources = [
      source({ id: "catalogue-1", type: "catalogue", content: "unga maize flour" }),
      source({ id: "catalogue-2", type: "catalogue", content: "sugar" }),
      source({ id: "policy-1", type: "policy", content: "always be polite" })
    ];
    const { items, diagnostics } = resolveAgentContext({
      sources,
      query: "do you have unga",
      audience: "owner",
      intent: "show_products",
      characterBudget: 5
    });
    expect(diagnostics.candidateNodes).toBe(3);
    // "sugar" never matches the query terms, and "policy" content ("always be polite") doesn't
    // either - only catalogue-1 is relevance-scored above zero for this query.
    expect(items.map((item) => item.sourceId)).toEqual(["catalogue-1"]);
    expect(diagnostics.selectedNodes).toBe(1);
    expect(diagnostics.rejectedNodes).toBe(2);
    expect(diagnostics.tokenBudget).toBe(Math.ceil(5 / 4));
    expect(diagnostics.byDomain.catalogue).toEqual({ candidates: 2, authorized: 2, selected: 1 });
  });
});

describe("evidence provenance and confidence", () => {
  it("gives a canonical-record-backed source full confidence and no non-canonical source is mistaken for one", () => {
    const canonical = source({
      id: "catalogue-1",
      type: "catalogue",
      content: "unga flour",
      sourceRecordId: "product-42"
    });
    const freeText = source({ id: "note-1", type: "owner_note", content: "unga owner note" });
    const { items } = resolveAgentContext({
      sources: [canonical, freeText],
      query: "unga",
      audience: "owner"
    });
    const canonicalItem = items.find((item) => item.sourceId === "catalogue-1");
    const noteItem = items.find((item) => item.sourceId === "note-1");
    expect(canonicalItem?.confidence).toBe(1);
    expect(canonicalItem?.provenance).toEqual({
      resolver: "canonical_record",
      sourceType: "catalogue",
      sourceId: "product-42"
    });
    expect(noteItem?.confidence).toBeNull();
    expect(noteItem?.provenance.resolver).toBe("owner_authored");
  });
});

describe("evaluateGrounding", () => {
  const recipe = contextRecipeRegistry.show_products!;

  it("is always grounded when the recipe has no grounding policy or no recipe matched", () => {
    const diagnostics = {
      candidateNodes: 0,
      selectedNodes: 0,
      rejectedNodes: 0,
      estimatedTokens: 0,
      tokenBudget: null,
      byDomain: {}
    };
    expect(evaluateGrounding({ recipe: undefined, retrievedContext: [], diagnostics }).status).toBe(
      "grounded"
    );
    expect(
      evaluateGrounding({
        recipe: { ...recipe, groundingPolicy: "none" },
        retrievedContext: [],
        diagnostics
      }).status
    ).toBe("grounded");
  });

  it("is grounded when a required domain is authoritatively empty (no candidates at all)", () => {
    const decision = evaluateGrounding({
      recipe,
      retrievedContext: [],
      diagnostics: {
        candidateNodes: 0,
        selectedNodes: 0,
        rejectedNodes: 0,
        estimatedTokens: 0,
        tokenBudget: null,
        byDomain: { catalogue: { candidates: 0, authorized: 0, selected: 0 } }
      }
    });
    expect(decision.status).toBe("grounded");
  });

  it("is insufficient_evidence when real, authorized records exist but none were retrieved", () => {
    const decision = evaluateGrounding({
      recipe,
      retrievedContext: [],
      diagnostics: {
        candidateNodes: 3,
        selectedNodes: 0,
        rejectedNodes: 3,
        estimatedTokens: 0,
        tokenBudget: null,
        byDomain: { catalogue: { candidates: 3, authorized: 3, selected: 0 } }
      }
    });
    expect(decision).toEqual({ status: "insufficient_evidence", missing: ["catalogue"] });
  });

  it("is unauthorized when real records exist but the caller cannot see any of them", () => {
    const decision = evaluateGrounding({
      recipe,
      retrievedContext: [],
      diagnostics: {
        candidateNodes: 3,
        selectedNodes: 0,
        rejectedNodes: 3,
        estimatedTokens: 0,
        tokenBudget: null,
        byDomain: { catalogue: { candidates: 3, authorized: 0, selected: 0 } }
      }
    });
    expect(decision).toEqual({ status: "unauthorized", missingScopes: ["catalogue"] });
  });

  it("produces a fixed, non-fabricated abstention message for each non-grounded status", () => {
    expect(
      groundingAbstentionMessage({ status: "insufficient_evidence", missing: ["catalogue"] })
    ).toContain("catalogue");
    expect(
      groundingAbstentionMessage({ status: "unauthorized", missingScopes: ["catalogue"] })
    ).toContain("permission");
  });
});

describe("nextRuntimeExperienceState", () => {
  const baseInput = {
    id: "exp-1",
    businessId: "shop-1",
    agentId: "agent-1",
    turnId: "turn-1",
    intent: "show_products" as const,
    recipeId: "grogoni.show_products@1",
    recipeVersion: 1,
    evidenceRefs: ["catalogue-1"],
    toolName: "products.list" as const,
    fallbackReason: "retryable-execution-failure",
    now: new Date("2026-09-01T00:00:00.000Z")
  };

  it("creates a new candidate with corroborationCount 1 and emits recall.candidate_generated", () => {
    const { experience, telemetryEvents } = nextRuntimeExperienceState(null, baseInput);
    expect(experience.validationState).toBe("candidate");
    expect(experience.corroborationCount).toBe(1);
    expect(experience.lessonKey).toBe("fallback:show_products:retryable-execution-failure");
    expect(telemetryEvents).toEqual([
      {
        state: "recall.candidate_generated",
        metadata: { experienceId: experience.id, lessonKey: experience.lessonKey }
      }
    ]);
  });

  it("promotes after a distinct corroborating turn without fabricating recipe/evidence changes", () => {
    const candidate: RuntimeExperience = nextRuntimeExperienceState(null, baseInput).experience;
    const result = nextRuntimeExperienceState(candidate, {
      ...baseInput,
      id: candidate.id,
      turnId: "turn-2"
    });
    expect(result.experience.corroborationCount).toBe(2);
    expect(result.experience.validationState).toBe("validated");
    expect(result.telemetryEvents.map((event) => event.state)).toEqual([
      "recall.deduplicated",
      "recall.persisted"
    ]);
  });

  it("does not re-emit recall.persisted once already validated", () => {
    const first = nextRuntimeExperienceState(null, baseInput);
    const second = nextRuntimeExperienceState(first.experience, { ...baseInput, turnId: "turn-2" });
    const third = nextRuntimeExperienceState(second.experience, { ...baseInput, turnId: "turn-3" });
    expect(third.experience.validationState).toBe("validated");
    expect(third.experience.corroborationCount).toBe(3);
    expect(third.telemetryEvents.map((event) => event.state)).toEqual(["recall.deduplicated"]);
  });

  it("does not count replayed turns, including nonconsecutive replays after rehydration", () => {
    const first = nextRuntimeExperienceState(null, baseInput).experience;
    const replay = nextRuntimeExperienceState(first, { ...baseInput, now: new Date("2026-09-02") });
    expect(replay.experience).toEqual(first);
    expect(replay.experience.validationState).toBe("candidate");
    const second = nextRuntimeExperienceState(first, { ...baseInput, turnId: "turn-2" }).experience;
    const restored = JSON.parse(JSON.stringify(second)) as RuntimeExperience;
    expect(nextRuntimeExperienceState(restored, baseInput).experience).toEqual(second);
  });

  it("does not invent a legacy record's untracked corroborating identities", () => {
    const legacy = nextRuntimeExperienceState(null, baseInput).experience;
    delete legacy.corroboratingTurnIds;
    legacy.corroborationCount = 30;
    const result = nextRuntimeExperienceState(legacy, baseInput).experience;
    expect(result.corroborationCount).toBe(1);
    expect(result.validationState).toBe("candidate");
  });

  it("rejects cross-business, agent, recipe, tool and deprecated corroborations", () => {
    const first = nextRuntimeExperienceState(null, baseInput).experience;
    for (const changed of [
      { ...first, shopId: "other" },
      { ...first, agentId: "other" },
      { ...first, recipeVersion: 2 },
      { ...first, toolSequence: ["customer.create" as const] },
      { ...first, validationState: "deprecated" as const }
    ]) {
      expect(() => nextRuntimeExperienceState(changed, baseInput)).toThrow("scope");
    }
  });

  it("bounds replay history without evicting older identifiers or refreshing retention on replay", () => {
    let experience = nextRuntimeExperienceState(null, baseInput).experience;
    for (let index = 2; index <= 70; index++) {
      experience = nextRuntimeExperienceState(experience, {
        ...baseInput,
        turnId: `turn-${index}`
      }).experience;
    }
    expect(experience.corroborationCount).toBe(64);
    expect(experience.corroboratingTurnIds).toHaveLength(64);
    expect(nextRuntimeExperienceState(experience, baseInput).experience).toEqual(experience);
  });
});

describe("buildRuntimeReportCard", () => {
  function turn(overrides: Partial<RuntimeTurnSummary> & { id: string }): RuntimeTurnSummary {
    return {
      id: overrides.id,
      sessionId: "session-1",
      businessId: "shop-1",
      actorId: "user-1",
      message: "show products",
      normalizedInput: "show products",
      parserIntent: "show_products",
      parserConfidence: 1,
      status: overrides.status ?? "completed",
      context: {
        businessId: "shop-1",
        userId: "user-1",
        role: "owner",
        productCount: 0,
        customerCount: 0,
        supplierCount: 0,
        invoiceCount: 0,
        openInvoiceCount: 0,
        paymentCount: 0,
        importJobCount: 0,
        logisticsCount: 0,
        activeLogisticsCount: 0,
        complianceExportCount: 0,
        scheduledDeletionCount: 0,
        verificationTier: "unverified",
        deviceTrustLevel: "unknown",
        betaAccessStatus: "not_requested",
        betaReadinessStatus: "not_ready",
        openSupportTicketCount: 0,
        crashFreeSessionRate: 1,
        publicLaunchStatus: "not_launched",
        launchReadinessStatus: "not_ready",
        openLaunchIncidentCount: 0,
        lowStockCount: 0,
        outstandingDebtTotal: 0,
        unreadNotificationCount: 0,
        knowledgeFactCount: 0
      },
      plan: {
        id: "plan-1",
        toolName: "products.list",
        risk: "low",
        requiresConfirmation: false,
        status: "safe_to_execute",
        input: {},
        validationErrors: [],
        confirmationToken: null,
        executedAt: null
      },
      verification: {
        ok: true,
        requiresConfirmation: false,
        confirmationSatisfied: false,
        roleAllowed: true,
        rateLimited: false,
        errors: []
      },
      model: overrides.model ?? {
        provider: null,
        status: "available",
        durationMs: 100,
        outputKind: "tool",
        errorCode: null,
        modelId: "model-a"
      },
      response: "ok",
      toolResult: null,
      telemetry: overrides.telemetry ?? [],
      runtimeVersion: overrides.runtimeVersion ?? 1,
      createdAt: "2026-09-01T00:00:00.000Z"
    };
  }

  it("groups by (runtimeVersion, modelId, recipeId) and computes success/grounding/latency metrics", () => {
    const groundingAccepted = {
      id: "t1",
      sessionId: "s",
      turnId: "turn-a",
      state: "grounding.accepted" as const,
      occurredAt: "2026-09-01T00:00:00.000Z",
      toolName: null,
      risk: null,
      status: "completed" as const,
      metadata: { recipeId: "grogoni.show_products@1" }
    };
    const groundingRejected = { ...groundingAccepted, state: "grounding.rejected" as const };
    const turns = [
      turn({ id: "turn-a", telemetry: [groundingAccepted] }),
      turn({ id: "turn-b", telemetry: [groundingRejected], status: "clarifying" }),
      turn({
        id: "turn-c",
        runtimeVersion: 2,
        model: {
          provider: null,
          status: "available",
          durationMs: 50,
          outputKind: "tool",
          errorCode: null,
          modelId: "model-b"
        }
      })
    ];
    const cards = buildRuntimeReportCard(turns);
    expect(cards).toHaveLength(2);
    const v1Card = cards.find((card) => card.key.runtimeVersion === 1)!;
    expect(v1Card.key).toEqual({
      runtimeVersion: 1,
      modelId: "model-a",
      recipeId: "grogoni.show_products@1"
    });
    expect(v1Card.sampleSize).toBe(2);
    expect(v1Card.taskSuccessRate).toBe(0.5);
    expect(v1Card.abstentionRate).toBe(0.5);
    expect(v1Card.groundedAcceptRate).toBe(0.5);
    expect(v1Card.averageLatencyMs).toBe(100);

    const v2Card = cards.find((card) => card.key.runtimeVersion === 2)!;
    expect(v2Card.key).toEqual({ runtimeVersion: 2, modelId: "model-b", recipeId: null });
    expect(v2Card.groundedAcceptRate).toBeNull();
  });

  it("does not credit deterministic business tasks to a configured model or its usage", () => {
    const planned = turn({ id: "planned" });
    planned.telemetry = [
      {
        id: "route",
        sessionId: planned.sessionId,
        turnId: planned.id,
        state: "intent.routed",
        occurredAt: planned.createdAt,
        toolName: null,
        risk: null,
        status: "completed",
        metadata: { source: "business_task" }
      }
    ];
    planned.model = { ...planned.model!, promptTokens: 30, completionTokens: 20 };
    const cards = buildRuntimeReportCard([planned, turn({ id: "model-invoked" })]);
    expect(cards).toHaveLength(2);
    const deterministic = cards.find((card) => card.key.modelId === null)!;
    expect(deterministic.sampleSize).toBe(1);
    expect(deterministic.averageLatencyMs).toBeNull();
    expect(deterministic.averagePromptTokens).toBeNull();
    expect(deterministic.averageCompletionTokens).toBeNull();
    expect(cards.find((card) => card.key.modelId === "model-a")?.sampleSize).toBe(1);
  });
});

describe("recall tenant isolation and grounding gate at the real HTTP seam", () => {
  it("authorizes native outcome reads and returns asynchronous persistence errors through the existing API", async () => {
    const list = vi.fn(async () => []);
    const store = createCp2Store({ businessTaskEvaluations: { list } });
    const app = buildApi({ cp2: { store } });
    try {
      const owner = await createOwnerBusiness(app, "+254700009005", "Evaluation Shop");
      const path = `/businesses/${owner.businessId}/agent-runtime/evaluations`;
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: { cookie: owner.cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().environmentOutcomes).toEqual([]);
      expect(list).toHaveBeenCalledTimes(1);
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
      expect(list).toHaveBeenCalledTimes(1);
      list.mockRejectedValueOnce(
        new Cp2Error(503, "evaluation_unavailable", "Evaluation read unavailable.")
      );
      const failed = await app.inject({
        method: "GET",
        url: path,
        headers: { cookie: owner.cookie }
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().code).toBe("evaluation_unavailable");
    } finally {
      await app.close();
    }
  });
  it("records no model attribution or latency for a parser-only runtime action", async () => {
    const store = createCp2Store({});
    const app = buildApi({ cp2: { store } });
    try {
      const owner = await createOwnerBusiness(app, "+254700009004", "Parser Shop");
      const result = await postJson<{ turn: RuntimeTurnSummary }>(
        app,
        `/businesses/${owner.businessId}/runtime/turns`,
        { message: "show products" },
        owner.cookie
      );
      expect(result.turn.model).toBeNull();
      const events = store
        .snapshot()
        .agentEvaluationEvents!.filter((event) => event.shopId === owner.businessId);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.modelId === null)).toBe(true);
      expect(events.some((event) => event.eventType === "response_latency")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("never lets Business B see a validated experience recorded for Business A", async () => {
    const store = createCp2Store({});
    const app = buildApi({ cp2: { store } });
    const businessA = await createOwnerBusiness(app, "+254700009001", "Shop A");
    const businessB = await createOwnerBusiness(app, "+254700009002", "Shop B");

    const now = new Date().toISOString();
    const experience: RuntimeExperience = {
      id: "exp-shopA-1",
      tenantId: businessA.businessId,
      shopId: businessA.businessId,
      agentId: businessA.businessId,
      taskType: "show_products",
      situation: "A test situation for shop A only.",
      lessonKey: "fallback:show_products:retryable-execution-failure",
      recipeId: "grogoni.show_products@1",
      recipeVersion: 1,
      evidenceRefs: [],
      toolSequence: ["products.list"],
      resultType: "products.list",
      verificationResult: "ok",
      outcome: "successful",
      lesson: "SHOP_A_ONLY_LESSON_MARKER",
      validationState: "validated",
      corroborationCount: 2,
      sourceTurnId: "turn-seed",
      createdAt: now,
      updatedAt: now,
      deprecatedAt: null
    };
    const snapshot = store.snapshot();
    store.hydrateSnapshot({ ...snapshot, runtimeExperiences: [experience] });

    const shopAExperiences = store.validatedRuntimeExperiencesForBusiness(businessA.businessId);
    const shopBExperiences = store.validatedRuntimeExperiencesForBusiness(businessB.businessId);
    expect(shopAExperiences.map((item) => item.id)).toEqual(["exp-shopA-1"]);
    expect(shopBExperiences).toEqual([]);

    await app.close();
  });

  it("substitutes a deterministic abstention message when the model answers a grounding-required intent with unretrieved free text, never blocking a genuinely empty-record answer", async () => {
    let callCount = 0;
    const provider: RuntimeModelProvider = {
      name: "fabricating-model",
      async complete() {
        callCount += 1;
        return {
          provider: "fabricating-model",
          status: "available",
          // A model answering in free text ("response" kind) instead of proposing
          // payments.debtors - exactly the path parseRuntimeModelOutput maps to toolName
          // "unknown.clarify" with validation: valid(), which createRuntimeResponse would
          // otherwise return verbatim.
          outputText: JSON.stringify({
            type: "response",
            message: "Exactly nobody owes you money right now."
          }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009003", "Empty Shop");

    // "check_debt" (packages/tool-core's rule parser) has no built-in deterministic
    // vocabulary/context-script matcher the way product commands do (see
    // parseProductContextScriptCommand), so this message reaches the model unconditionally.
    // No customers/invoices exist for this business - candidateNodes for "customer"/"order" is 0,
    // so grounding must treat this as authoritatively empty and let the model's reply through.
    const emptyShopTurn = await postJson<{ turn: { response: string } }>(
      app,
      `/businesses/${owner.businessId}/runtime/turns`,
      { message: "who owes me money" },
      owner.cookie
    );
    expect(emptyShopTurn.turn.response).toContain("nobody owes you money");
    expect(callCount).toBe(1);

    // Add a real customer whose name never overlaps the query below, so retrieval genuinely
    // selects nothing for "customer"/"order" even though a real, authorized record now exists -
    // this must trigger insufficient_evidence and override the model's fabricated free text.
    await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/customers`,
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: JSON.stringify({ name: "Zawadi" })
    });
    const secondTurn = await postJson<{ turn: { response: string; status: string } }>(
      app,
      `/businesses/${owner.businessId}/runtime/turns`,
      { message: "who owes me money" },
      owner.cookie
    );
    expect(secondTurn.turn.response).not.toContain("nobody owes you money");
    expect(secondTurn.turn.status).toBe("clarifying");
    expect(callCount).toBe(2);

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  contact: string,
  name: string
): Promise<{ businessId: string; cookie: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  const setCookie = signup.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (cookieValue === undefined) throw new Error("Expected an authenticated session cookie.");
  const cookie = cookieValue.split(";")[0] ?? cookieValue;
  const response = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(response.statusCode).toBe(200);
  return {
    businessId: response.json<{ business: { id: string } }>().business.id,
    cookie
  };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  body: unknown,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(body)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
