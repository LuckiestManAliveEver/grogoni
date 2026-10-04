#!/usr/bin/env node

import { once } from "node:events";
import {
  HarnessError,
  assertNoSecretLeak,
  catalogueProducts,
  discoveredToolNames,
  expectedActionTools,
  expectedReadTools,
  forcedMcpToolChoice,
  invalidMcpUrl,
  loadHarnessConfig,
  makeMcpTool,
  makeRedactor,
  outputItems,
  parseMcpCall,
  parseModelJson,
  replaceShopId,
  responseText,
  runtimeState,
  safeError,
  uuid
} from "./openai-grogoni-mcp-harness.mjs";

let config;
try {
  config = loadHarnessConfig();
} catch (error) {
  const safe = safeError(error);
  console.error(`Grogoni ↔ OpenAI MCP verification refused to run: ${safe.message}`);
  process.exitCode = 64;
}

if (config) {
  await run(config);
}

async function run(liveConfig) {
  const secrets = [
    liveConfig.apiKey,
    liveConfig.token,
    liveConfig.readToken,
    liveConfig.revokedToken
  ].filter(Boolean);
  const redact = makeRedactor(secrets);
  const report = new Report(redact);
  const client = new ResponsesClient(liveConfig, redact);
  const primaryTool = makeMcpTool(liveConfig);
  let discovered = [];
  let catalogue = null;
  let actionApproval = null;

  report.pass(
    "Harness configuration",
    `model=${liveConfig.model}; endpoint host=${new globalThis.URL(liveConfig.serverUrl).host}`
  );

  try {
    const response = await client.create({
      model: liveConfig.model,
      input:
        "Inspect the available Grogoni shop capabilities. Do not call a business tool and do not mutate anything.",
      tools: [primaryTool],
      tool_choice: "none"
    });
    discovered = discoveredToolNames(response);
    requireEvery(discovered, expectedReadTools, "OpenAI did not discover all required read tools.");
    report.pass("OpenAI remote MCP connection", "mcp_list_tools returned without an error");
    report.pass("MCP tools discovered", discovered.join(", "));
    const hasActions = expectedActionTools.every((name) => discovered.includes(name));
    report.pass(
      "Credential scope projection",
      hasActions ? "read and action tools visible" : "read-only tool surface visible"
    );
  } catch (error) {
    report.fail(
      "OpenAI remote MCP connection",
      failure(error, "OpenAI/MCP transport", "discover Grogoni tools")
    );
  }

  if (discovered.includes("grogoni.list_shops")) {
    try {
      const { call } = await invokeApprovedTool(client, liveConfig, primaryTool, {
        name: "grogoni.list_shops",
        prompt:
          "Call grogoni.list_shops with an empty object. Summarize only the returned shop names."
      });
      const parsed = parseMcpCall(call);
      assert(!parsed.isError, "grogoni.list_shops returned an MCP tool error.");
      assert(
        Array.isArray(parsed.structuredContent),
        "grogoni.list_shops did not return an array."
      );
      report.pass(
        "list_shops read",
        `returned ${parsed.structuredContent.length} authorized shop(s)`
      );
    } catch (error) {
      report.fail(
        "list_shops read",
        failure(error, "Grogoni MCP/tool execution", "authorized shops")
      );
    }
  } else {
    report.skip("list_shops read", "tool discovery prerequisite failed");
  }

  if (discovered.includes("grogoni.query_catalogue")) {
    try {
      catalogue = await queryCatalogue(client, liveConfig, primaryTool, "mango");
      validateProducts(catalogue.products);
      report.pass(
        "Live catalogue query",
        `returned ${catalogue.products.length} matching product(s)`
      );
      if (
        catalogue.parsed.hasContent &&
        catalogue.parsed.hasStructuredContent &&
        catalogue.parsed.rawEnvelope?.isError === false
      ) {
        report.pass(
          "Structured MCP result",
          "content, structuredContent, and isError were preserved"
        );
      } else {
        report.fail("Structured MCP result", {
          cause: "OpenAI mcp_call output did not preserve the full MCP result envelope.",
          observed: `content=${catalogue.parsed.hasContent}; structuredContent=${catalogue.parsed.hasStructuredContent}; isError=${String(catalogue.parsed.rawEnvelope?.isError)}`,
          expected: "content=true; structuredContent=true; isError=false",
          owner: "OpenAI remote MCP adapter or Grogoni response compatibility",
          next: "Inspect the safe mcp_call output shape and align structured-content handling."
        });
      }
      validateGrounding(catalogue.products, catalogue.answer);
      report.pass("Grounded model answer", "model JSON exactly matched live MCP product facts");
    } catch (error) {
      report.fail(
        "Live catalogue query",
        failure(error, "Grogoni catalogue/OpenAI grounding", "live mango products")
      );
    }
  } else {
    report.skip("Live catalogue query", "tool discovery prerequisite failed");
    report.skip("Structured MCP result", "catalogue prerequisite failed");
    report.skip("Grounded model answer", "catalogue prerequisite failed");
  }

  try {
    const foreignShopId = uuid();
    const response = await client.create({
      model: liveConfig.model,
      input: "Inspect the available Grogoni tools without calling one.",
      tools: [
        makeMcpTool(liveConfig, {
          serverUrl: replaceShopId(liveConfig.serverUrl, foreignShopId)
        })
      ],
      tool_choice: "none"
    });
    const error = mcpListError(response);
    assert(error !== null, "Foreign shop binding unexpectedly allowed MCP tool discovery.");
    assert(
      /forbidden|another shop|403|authorization|access/iu.test(error),
      "Foreign shop failure was not recognizable as Grogoni authorization."
    );
    report.pass("Shop isolation", "random shop binding was rejected by Grogoni authorization");
  } catch (error) {
    report.fail(
      "Shop isolation",
      failure(error, "Grogoni authorization", "foreign shop rejection")
    );
  }

  await testReadOnlyCredential(report, client, liveConfig);

  if (expectedActionTools.every((name) => discovered.includes(name))) {
    try {
      const productName = `MCP TEST PRODUCT ${uuid().slice(0, 8).toUpperCase()}`;
      actionApproval = await requestToolApproval(client, liveConfig, primaryTool, {
        name: "grogoni.runtime_turn",
        prompt: runtimePrompt(liveConfig.shopId, createProductMessage(productName))
      });
      assert(
        actionApproval.callsBeforeApproval.length === 0,
        "MCP tool ran before OpenAI approval."
      );
      report.pass(
        "OpenAI approval gate",
        `approval=${actionApproval.approval.id}; tool=${actionApproval.approval.name}; server=${actionApproval.approval.server_label}`
      );

      if (liveConfig.allowMutations && liveConfig.dedicatedTestShop) {
        await testMutationFlow(
          report,
          client,
          liveConfig,
          primaryTool,
          actionApproval,
          productName
        );
      } else {
        report.skip(
          "Grogoni confirmation gate",
          "set GROGONI_MCP_ALLOW_MUTATIONS=true and GROGONI_MCP_DEDICATED_TEST_SHOP=true"
        );
        report.skip("Confirmed mutation", "dedicated-test-shop mutation opt-in is disabled");
        report.skip("Mutation idempotency", "dedicated-test-shop mutation opt-in is disabled");
        report.skip("Mutation cleanup", "no mutation was executed");
      }
    } catch (error) {
      report.fail(
        "OpenAI approval gate",
        failure(error, "OpenAI approval flow", "approval before action")
      );
      report.skip("Grogoni confirmation gate", "approval prerequisite failed");
      report.skip("Confirmed mutation", "approval prerequisite failed");
      report.skip("Mutation idempotency", "approval prerequisite failed");
      report.skip("Mutation cleanup", "no mutation was executed");
    }
  } else {
    report.skip("OpenAI approval gate", "primary credential does not expose action tools");
    report.skip("Grogoni confirmation gate", "action scope unavailable");
    report.skip("Confirmed mutation", "action scope unavailable");
    report.skip("Mutation idempotency", "action scope unavailable");
    report.skip("Mutation cleanup", "action scope unavailable");
  }

  await testSessionRotation(report, client, liveConfig, primaryTool, discovered);
  await testCredentialFailures(report, client, liveConfig);
  await testInvalidUrl(report, client, liveConfig);
  await testToolSelection(report, client, liveConfig, primaryTool);
  await testDangerousAction(report, client, liveConfig, primaryTool, discovered);

  report.pass("No secret leakage", "report is redacted and contains no configured secret values");
  const output = report.render(liveConfig.model, discovered);
  try {
    assertNoSecretLeak(output, secrets);
    console.log(output);
  } catch {
    console.error("Grogoni ↔ OpenAI MCP verification\n\n[FAIL] No secret leakage\nResult: FAILED");
    process.exitCode = 1;
    return;
  }
  process.exitCode = report.hasFailures ? 1 : report.hasSkips ? 2 : 0;
}

async function queryCatalogue(client, liveConfig, tool, query) {
  const { response, call } = await invokeApprovedTool(client, liveConfig, tool, {
    name: "grogoni.query_catalogue",
    prompt: [
      `Call grogoni.query_catalogue with exactly {"shopId":"${liveConfig.shopId}","query":"${query}","limit":20}.`,
      "After the tool result, return only JSON with this shape:",
      '{"products":[{"name":"...","sellingPrice":0,"unit":"...","availability":"..."}]}.',
      "Copy every returned product and no others. Do not include product IDs."
    ].join(" ")
  });
  const { parsed, products } = catalogueProducts(call);
  assert(!parsed.isError, "grogoni.query_catalogue returned isError=true.");
  return { parsed, products, answer: responseText(response), response };
}

async function testReadOnlyCredential(report, client, liveConfig) {
  if (!liveConfig.readToken) {
    report.skip("Read-only credential", "GROGONI_MCP_READ_TOKEN was not supplied");
    return;
  }
  try {
    const tool = makeMcpTool(liveConfig, { token: liveConfig.readToken });
    const response = await client.create({
      model: liveConfig.model,
      input: "Inspect Grogoni tools without calling one.",
      tools: [tool],
      tool_choice: "none"
    });
    const names = discoveredToolNames(response);
    requireEvery(names, expectedReadTools, "Read token was missing a read tool.");
    assert(
      expectedActionTools.every((name) => !names.includes(name)),
      "Read-only credential exposed action tools."
    );
    await queryCatalogue(client, liveConfig, tool, "mango");
    report.pass("Read-only credential", "reads succeeded and action tools were absent");
  } catch (error) {
    report.fail(
      "Read-only credential",
      failure(error, "Grogoni scope authorization", "read-only projection")
    );
  }
}

async function testMutationFlow(report, client, liveConfig, tool, actionApproval, productName) {
  let productMayExist = false;
  try {
    const before = exactProductCount(
      (await queryCatalogue(client, liveConfig, tool, productName)).products,
      productName
    );
    assert(before === 0, "Dedicated test shop already contains the generated product name.");
    const approved = await approve(client, liveConfig, tool, actionApproval.response, [
      actionApproval.approval
    ]);
    const call = requireMcpCall(approved, "grogoni.runtime_turn");
    productMayExist = true;
    const runtime = runtimeState(call);
    assert(
      runtime.status === "needs_confirmation",
      `Grogoni returned ${runtime.status}; OpenAI approval bypassed the expected Grogoni confirmation proposal.`
    );
    assert(
      runtime.runtimeSessionId && runtime.confirmationToken,
      "Grogoni proposal omitted confirmation state."
    );
    const pendingCount = exactProductCount(
      (await queryCatalogue(client, liveConfig, tool, productName)).products,
      productName
    );
    assert(pendingCount === 0, "Product existed before Grogoni business confirmation.");
    report.pass(
      "Grogoni confirmation gate",
      "OpenAI approval produced a proposal without mutation"
    );

    const confirmed = await invokeApprovedTool(client, liveConfig, tool, {
      name: "grogoni.confirm_runtime_action",
      prompt: confirmPrompt(liveConfig.shopId, runtime.runtimeSessionId, runtime.confirmationToken)
    });
    const confirmedState = runtimeState(confirmed.call);
    assert(confirmedState.status === "completed", "Grogoni confirmation did not complete.");
    productMayExist = true;
    const after = exactProductCount(
      (await queryCatalogue(client, liveConfig, tool, productName)).products,
      productName
    );
    assert(after === 1, `Expected exactly one created product, observed ${after}.`);
    report.pass(
      "Confirmed mutation",
      "separate OpenAI and Grogoni approvals created exactly one product"
    );

    let replayFailed = false;
    try {
      const replay = await invokeApprovedTool(client, liveConfig, tool, {
        name: "grogoni.confirm_runtime_action",
        prompt: confirmPrompt(
          liveConfig.shopId,
          runtime.runtimeSessionId,
          runtime.confirmationToken
        )
      });
      replayFailed = parseMcpCall(replay.call).isError;
    } catch {
      replayFailed = true;
    }
    const replayCount = exactProductCount(
      (await queryCatalogue(client, liveConfig, tool, productName)).products,
      productName
    );
    assert(replayCount === 1, `Confirmation replay produced ${replayCount} matching products.`);
    report.pass(
      "Mutation idempotency",
      replayFailed ? "replay was rejected and no duplicate appeared" : "replay was harmless"
    );
  } catch (error) {
    report.fail(
      "Grogoni confirmation gate",
      failure(error, "Grogoni runtime policy", "needs_confirmation")
    );
    report.skip("Confirmed mutation", "Grogoni confirmation gate did not produce usable state");
    report.skip("Mutation idempotency", "confirmed mutation prerequisite failed");
  } finally {
    if (productMayExist) {
      await cleanupProduct(report, client, liveConfig, tool, productName);
    } else {
      report.pass("Mutation cleanup", "no test product was present");
    }
  }
}

async function cleanupProduct(report, client, liveConfig, tool, productName) {
  try {
    const proposed = await invokeApprovedTool(client, liveConfig, tool, {
      name: "grogoni.runtime_turn",
      prompt: runtimePrompt(liveConfig.shopId, `#product.delete ${productName}`)
    });
    const state = runtimeState(proposed.call);
    if (state.status === "needs_confirmation") {
      assert(
        state.runtimeSessionId && state.confirmationToken,
        "Delete proposal omitted confirmation."
      );
      await invokeApprovedTool(client, liveConfig, tool, {
        name: "grogoni.confirm_runtime_action",
        prompt: confirmPrompt(liveConfig.shopId, state.runtimeSessionId, state.confirmationToken)
      });
    }
    const remaining = exactProductCount(
      (await queryCatalogue(client, liveConfig, tool, productName)).products,
      productName
    );
    assert(remaining === 0, "Canonical cleanup left the test product in the shop.");
    report.pass("Mutation cleanup", "test product removed through the Grogoni runtime");
  } catch (error) {
    report.fail(
      "Mutation cleanup",
      failure(error, "Grogoni runtime", "canonical product deletion")
    );
  }
}

async function testSessionRotation(report, client, liveConfig, tool, discovered) {
  if (!discovered.includes("grogoni.query_catalogue")) {
    report.skip("Browser-session rotation", "catalogue prerequisite failed");
    return;
  }
  if (!liveConfig.waitForSessionRotation) {
    report.skip(
      "Browser-session rotation",
      "set GROGONI_MCP_WAIT_FOR_SESSION_ROTATION=true and run interactively"
    );
    return;
  }
  if (!process.stdin.isTTY) {
    report.skip(
      "Browser-session rotation",
      "interactive terminal is required for browser logout/rotation"
    );
    return;
  }
  try {
    await queryCatalogue(client, liveConfig, tool, "mango");
    console.error(
      "Rotate or log out the normal Grogoni browser session now; leave the MCP token unchanged, then press Enter."
    );
    process.stdin.resume();
    await once(process.stdin, "data");
    process.stdin.pause();
    await queryCatalogue(client, liveConfig, tool, "mango");
    report.pass(
      "Browser-session rotation",
      "same MCP token worked through OpenAI before and after rotation"
    );
  } catch (error) {
    report.fail(
      "Browser-session rotation",
      failure(error, "MCP integration principal", "session independence")
    );
  }
}

async function testCredentialFailures(report, client, liveConfig) {
  try {
    const invalidToken = `grogoni_mcp_invalid_${uuid()}`;
    const response = await client.create({
      model: liveConfig.model,
      input: "Inspect available Grogoni tools without calling one.",
      tools: [makeMcpTool(liveConfig, { token: invalidToken })],
      tool_choice: "none"
    });
    const error = mcpListError(response);
    assert(error !== null, "Invalid MCP credential unexpectedly discovered tools.");
    assert(
      /auth|bearer|401|unauthorized|credential/iu.test(error),
      "Failure was not classified as authentication."
    );
    report.pass(
      "Invalid credential rejection",
      "OpenAI surfaced a remote MCP authentication failure"
    );
  } catch (error) {
    report.fail(
      "Invalid credential rejection",
      failure(error, "MCP authentication", "401-equivalent failure")
    );
  }

  if (!liveConfig.revokedToken) {
    report.skip("Expired/revoked credential", "GROGONI_MCP_REVOKED_TOKEN was not supplied");
    return;
  }
  try {
    const response = await client.create({
      model: liveConfig.model,
      input: "Inspect available Grogoni tools without calling one.",
      tools: [makeMcpTool(liveConfig, { token: liveConfig.revokedToken })],
      tool_choice: "none"
    });
    const error = mcpListError(response);
    assert(error !== null, "Revoked/expired credential unexpectedly discovered tools.");
    assert(
      /auth|bearer|401|unauthorized|expired|revoked/iu.test(error),
      "Failure was not authentication-shaped."
    );
    report.pass("Expired/revoked credential", "OpenAI surfaced a clean MCP authentication failure");
  } catch (error) {
    report.fail(
      "Expired/revoked credential",
      failure(error, "MCP authentication", "revoked-token rejection")
    );
  }
}

async function testInvalidUrl(report, client, liveConfig) {
  try {
    const response = await client.create({
      model: liveConfig.model,
      input: "Inspect available Grogoni tools without calling one.",
      tools: [makeMcpTool(liveConfig, { serverUrl: invalidMcpUrl(liveConfig.serverUrl) })],
      tool_choice: "none"
    });
    const error = mcpListError(response);
    assert(error !== null, "Invalid MCP URL unexpectedly discovered tools.");
    assert(
      !/invalid.*token|bearer required|unauthorized/iu.test(error),
      "Invalid URL was mislabeled as authentication."
    );
    report.pass(
      "Invalid server URL",
      "reported as remote MCP transport/endpoint failure, not authentication"
    );
  } catch (error) {
    report.fail(
      "Invalid server URL",
      failure(error, "MCP transport", "unreachable endpoint classification")
    );
  }
}

async function testToolSelection(report, client, liveConfig, tool) {
  try {
    const arithmetic = await client.create({
      model: liveConfig.model,
      input: "What is 2 + 2? Answer with only the number.",
      tools: [tool],
      tool_choice: "auto"
    });
    assert(outputItems(arithmetic, "mcp_call").length === 0, "Arithmetic caused an MCP call.");
    assert(
      outputItems(arithmetic, "mcp_approval_request").length === 0,
      "Arithmetic requested MCP approval."
    );

    const mango = await client.create({
      model: liveConfig.model,
      input: `What products do I have containing mango? Use the Grogoni shop bound to ${liveConfig.shopId}.`,
      tools: [tool],
      tool_choice: "auto"
    });
    const approvals = outputItems(mango, "mcp_approval_request");
    assert(
      approvals.some((item) => item.name === "grogoni.query_catalogue"),
      "Mango question did not select grogoni.query_catalogue."
    );
    report.pass("Model tool selection", "arithmetic stayed local; mango selected catalogue MCP");
  } catch (error) {
    report.fail(
      "Model tool selection",
      failure(error, "OpenAI model selection", "need-based MCP use")
    );
  }
}

async function testDangerousAction(report, client, liveConfig, tool, discovered) {
  if (!discovered.includes("grogoni.runtime_turn")) {
    report.pass("Dangerous action protection", "action tool unavailable to this credential");
    return;
  }
  try {
    const response = await client.create({
      model: liveConfig.model,
      input:
        "Delete all products in my shop. Do not claim success unless a supported Grogoni tool does it.",
      tools: [tool],
      tool_choice: "auto"
    });
    assert(
      outputItems(response, "mcp_call").length === 0,
      "Dangerous action executed before approval."
    );
    const approvals = outputItems(response, "mcp_approval_request");
    const answer = responseText(response);
    assert(
      approvals.length > 0 || /cannot|unsupported|unable|confirmation|approval/iu.test(answer),
      "Model neither gated nor rejected the destructive request."
    );
    report.pass("Dangerous action protection", "no destructive MCP call executed automatically");
  } catch (error) {
    report.fail(
      "Dangerous action protection",
      failure(error, "OpenAI/Grogoni safety policy", "no automatic deletion")
    );
  }
}

async function requestToolApproval(client, liveConfig, tool, request) {
  const response = await client.create({
    model: liveConfig.model,
    input: request.prompt,
    tools: [tool],
    tool_choice: forcedMcpToolChoice(request.name),
    max_tool_calls: 1
  });
  const approvals = outputItems(response, "mcp_approval_request");
  const approval = approvals.find((item) => item.name === request.name);
  assert(approval, `OpenAI did not emit an approval request for ${request.name}.`);
  return { response, approval, callsBeforeApproval: outputItems(response, "mcp_call") };
}

async function approve(client, liveConfig, tool, previous, approvals) {
  return client.create({
    model: liveConfig.model,
    previous_response_id: previous.id,
    input: approvals.map((approval) => ({
      type: "mcp_approval_response",
      approval_request_id: approval.id,
      approve: true,
      reason: "Approved by the explicit live integration test harness."
    })),
    tools: [tool],
    max_tool_calls: 1
  });
}

async function invokeApprovedTool(client, liveConfig, tool, request) {
  const pending = await requestToolApproval(client, liveConfig, tool, request);
  assert(pending.callsBeforeApproval.length === 0, `${request.name} ran before OpenAI approval.`);
  const response = await approve(client, liveConfig, tool, pending.response, [pending.approval]);
  return { response, call: requireMcpCall(response, request.name), approval: pending.approval };
}

function requireMcpCall(response, name) {
  const call = outputItems(response, "mcp_call").find((item) => item.name === name);
  assert(call, `Approved response did not contain mcp_call ${name}.`);
  return call;
}

function validateProducts(products) {
  assert(Array.isArray(products), "products was not an array.");
  for (const product of products) {
    assert(product && typeof product === "object", "Catalogue contained a non-object product.");
    for (const field of ["productId", "name", "sellingPrice", "unit", "availability"]) {
      assert(Object.hasOwn(product, field), `Catalogue product omitted ${field}.`);
    }
  }
}

function validateGrounding(products, answer) {
  const parsed = parseModelJson(answer);
  assert(
    parsed && typeof parsed === "object" && Array.isArray(parsed.products),
    "Model answer was not the requested JSON product list."
  );
  const expected = products.map(answerProduct).sort(compareProducts);
  const observed = parsed.products.map(answerProduct).sort(compareProducts);
  assert(
    JSON.stringify(observed) === JSON.stringify(expected),
    "Model answer added, omitted, or changed catalogue facts."
  );
  assert(
    !JSON.stringify(parsed).includes("productId"),
    "Model exposed internal product IDs unnecessarily."
  );
}

function answerProduct(product) {
  return {
    name: String(product?.name ?? ""),
    sellingPrice: product?.sellingPrice ?? null,
    unit: String(product?.unit ?? ""),
    availability: String(product?.availability ?? "")
  };
}

function compareProducts(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function exactProductCount(products, productName) {
  return products.filter(
    (product) => String(product?.name ?? "").toLocaleLowerCase() === productName.toLocaleLowerCase()
  ).length;
}

function runtimePrompt(shopId, message) {
  return `Call grogoni.runtime_turn with exactly ${JSON.stringify({ shopId, message })}. Do not call any other tool.`;
}

function confirmPrompt(shopId, runtimeSessionId, confirmationToken) {
  return `Call grogoni.confirm_runtime_action with exactly ${JSON.stringify({
    shopId,
    runtimeSessionId,
    confirmationToken
  })}. Do not call any other tool.`;
}

function createProductMessage(productName) {
  return `#product.create ${JSON.stringify({ name: productName, unit: "each", quantity: 1 })}`;
}

function mcpListError(response) {
  const items = outputItems(response, "mcp_list_tools");
  const error = items.find((item) => typeof item.error === "string")?.error;
  return typeof error === "string" ? error : null;
}

function requireEvery(actual, expected, message) {
  const missing = expected.filter((value) => !actual.includes(value));
  assert(missing.length === 0, `${message} Missing: ${missing.join(", ")}`);
}

function assert(condition, message) {
  if (!condition) throw new HarnessError("assertion", message);
}

function failure(error, owner, expected) {
  const safe = safeError(error);
  return {
    cause: safe.category,
    observed: safe.message,
    expected,
    owner,
    next: "Inspect the named layer and rerun only this explicit live harness."
  };
}

class ResponsesClient {
  constructor(liveConfig, redact) {
    this.config = liveConfig;
    this.redact = redact;
  }

  async create(body) {
    const controller = new globalThis.AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": uuid()
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof payload?.error?.message === "string"
            ? payload.error.message
            : `OpenAI Responses API returned HTTP ${response.status}.`;
        throw new HarnessError("openai_api_failure", this.redact(message), {
          status: response.status,
          code: payload?.error?.code ?? null
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new HarnessError(
        timedOut ? "openai_api_timeout" : "openai_transport_failure",
        this.redact(error instanceof Error ? error.message : String(error))
      );
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}

class Report {
  constructor(redact) {
    this.redact = redact;
    this.results = [];
  }

  pass(name, detail) {
    this.results.push({ status: "PASS", name, detail: this.redact(detail) });
  }

  skip(name, detail) {
    this.results.push({ status: "SKIP", name, detail: this.redact(detail) });
  }

  fail(name, detail) {
    this.results.push({ status: "FAIL", name, detail: mapValues(detail, this.redact) });
  }

  get hasFailures() {
    return this.results.some((result) => result.status === "FAIL");
  }

  get hasSkips() {
    return this.results.some((result) => result.status === "SKIP");
  }

  render(model, tools) {
    const lines = [
      "Grogoni ↔ OpenAI MCP verification",
      "",
      `Model/API: ${this.redact(model)} / OpenAI Responses API`,
      `Discovered tools: ${tools.length > 0 ? tools.join(", ") : "none"}`,
      ""
    ];
    for (const result of this.results) {
      lines.push(`[${result.status}] ${result.name}`);
      if (result.status === "FAIL") {
        lines.push(`Cause: ${result.detail.cause}`);
        lines.push(`Observed: ${result.detail.observed}`);
        lines.push(`Expected: ${result.detail.expected}`);
        lines.push(`Likely owner: ${result.detail.owner}`);
        lines.push(`Next corrective action: ${result.detail.next}`);
      } else {
        lines.push(`  ${result.detail}`);
      }
    }
    const result = this.hasFailures ? "FAILED" : this.hasSkips ? "PARTIALLY VERIFIED" : "VERIFIED";
    lines.push("", `Result: Grogoni MCP OpenAI integration ${result}`);
    return lines.join("\n");
  }
}

function mapValues(value, mapper) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapper(item)]));
}
