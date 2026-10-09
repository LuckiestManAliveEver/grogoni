import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomInt, randomUUID } from "node:crypto";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { databasePoolConfig } from "../services/api/scripts/database-connection.mjs";
import { connectDatabase } from "../supabase/functions/api/database-connection.ts";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live to create disposable business fixtures.");
const base =
  process.env.SMOKE_API_URL ??
  "https://gnmndzsughifhboqvsgd.supabase.co/functions/v1/api-candidate";
const require = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Client } = require("pg");
const phones = [0, 1].map(() => `+254712${String(randomInt(1000000)).padStart(6, "0")}`);
const cleanupDevice = process.argv.find((arg) => arg.startsWith("--cleanup-device="))?.slice(17);
if (cleanupDevice && !/^edge-business-smoke-[a-f0-9-]{36}$/.test(cleanupDevice))
  throw new Error("Invalid cleanup fixture device.");
const device = cleanupDevice ?? `edge-business-smoke-${randomUUID()}`;
console.log(`Fixture device: ${device}`);
const accountIds = new Set();
const businessIds = new Set();
async function call(path, method = "GET", body, cookie = "", extraHeaders = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: "https://grogoni.com",
      "Content-Type": "application/json",
      "x-grogoni-device-id": device,
      cookie,
      ...extraHeaders
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: globalThis.AbortSignal.timeout(30000)
  });
  const result = await response.json().catch(() => {
    throw new Error(`${method} ${path} returned HTTP ${response.status} without valid JSON`);
  });
  return {
    status: response.status,
    result,
    sessionId: response.headers.get("mcp-session-id"),
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
  };
}
function ok(response, label) {
  assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.result)}`);
  console.log(`PASS ${label}`);
  return response.result;
}
let workflowFailure;
try {
  if (!cleanupDevice) {
    const owner = await call("/auth/pin/signup", "POST", {
      method: "phone",
      contact: phones[0],
      pin: "1234"
    });
    accountIds.add(ok(owner, "Owner signup").account.id);
    const other = await call("/auth/pin/signup", "POST", {
      method: "phone",
      contact: phones[1],
      pin: "4321"
    });
    accountIds.add(ok(other, "Other signup").account.id);
    const created = ok(
      await call(
        "/businesses",
        "POST",
        { name: `Edge Smoke ${randomUUID()}`, language: "en" },
        owner.cookie
      ),
      "Business creation"
    );
    const businessId = created.business.id;
    businessIds.add(businessId);
    const shops = ok(await call("/v1/shops", "GET", undefined, owner.cookie), "Shop restore");
    assert.ok(JSON.stringify(shops).includes(businessId));
    const product = ok(
      await call(
        `/businesses/${businessId}/products`,
        "POST",
        {
          name: "Disposable rice",
          sku: "EDGE-SMOKE",
          unit: "bag",
          quantity: 4,
          buyingPrice: 120,
          sellingPrice: 180
        },
        owner.cookie
      ),
      "Product create"
    );
    assert.ok(product.product?.id ?? product.id);
    const products = ok(
      await call(`/businesses/${businessId}/products`, "GET", undefined, owner.cookie),
      "Product restore"
    );
    assert.ok(JSON.stringify(products).includes("EDGE-SMOKE"));
    const denied = await call(`/businesses/${businessId}/products`, "GET", undefined, other.cookie);
    assert.ok([403, 404].includes(denied.status), "Another account must not read products");
    const publicView = ok(
      await call(`/public/storefronts/${encodeURIComponent(created.business.grogoniId)}`),
      "Public storefront"
    );
    assert.ok(!JSON.stringify(publicView).includes("EDGE-SMOKE"), "Public storefront leaked SKU");
    assert.ok(!JSON.stringify(publicView).includes("buyingPrice"), "Public storefront leaked cost");
    const invitation = ok(
      await call(
        `/businesses/${businessId}/staff/invitations`,
        "POST",
        { name: "Disposable staff", role: "cashier", phone: phones[1], country: "KE" },
        owner.cookie
      ),
      "Staff invitation"
    );
    const invitationId = invitation.invitation?.id ?? invitation.id;
    assert.ok(invitationId);
    const inbox = ok(
      await call("/v1/staff-invitations", "GET", undefined, other.cookie),
      "Staff invitation restore"
    );
    assert.ok(JSON.stringify(inbox).includes(invitationId));
    ok(
      await call(`/v1/staff-invitations/${invitationId}/accept`, "POST", {}, other.cookie),
      "Staff join"
    );
    const joined = ok(
      await call("/v1/shops", "GET", undefined, other.cookie),
      "Staff shop restore"
    );
    assert.ok(JSON.stringify(joined).includes(businessId));
    const token = ok(
      await call(
        "/v1/mcp/tokens",
        "POST",
        {
          name: "Disposable smoke",
          scopes: ["mcp:read"],
          shopId: businessId
        },
        owner.cookie
      ),
      "MCP token"
    );
    const initialized = await call(
      "/mcp",
      "POST",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "smoke", version: "1" }
        }
      },
      "",
      { authorization: `Bearer ${token.accessToken}` }
    );
    ok(initialized, "MCP initialize");
    const tools = ok(
      await call(
        "/mcp",
        "POST",
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list"
        },
        "",
        { authorization: `Bearer ${token.accessToken}`, "mcp-session-id": initialized.sessionId }
      ),
      "MCP tools restore"
    );
    assert.ok(tools.result.tools.length > 0);
    const extracted = ok(
      await call(
        `/businesses/${businessId}/documents/extract`,
        "POST",
        {
          fileName: "smoke.pdf",
          contentType: "application/pdf",
          contentBase64: smokePdf().toString("base64")
        },
        owner.cookie
      ),
      "PDF extraction"
    );
    assert.ok(extracted.text.includes("Edge PDF smoke"));
    console.log("PASS live MCP session restore and PDF extraction");
    console.log("PASS live staff invitation, acceptance, and membership restore");
    console.log(
      "PASS live business creation, shop restore, product persistence, account isolation, and public privacy"
    );
  }
} catch (error) {
  workflowFailure = error;
  throw error;
} finally {
  await cleanupWithContext(workflowFailure);
}

async function cleanupWithContext(failure) {
  try {
    await cleanup();
  } catch (error) {
    if (failure)
      throw new AggregateError([failure, error], "Workflow and fixture cleanup both failed");
    throw error;
  }
}

async function cleanup() {
  const client = await connectDatabase(
    () =>
      new Client({
        ...databasePoolConfig(process.env.DATABASE_URL),
        connectionTimeoutMillis: 10000
      })
  );
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    const recovered = await client.query(
      "select a.id from accounts a join sessions s on s.account_id = a.id where (a.primary_auth_destination = any($1::text[]) or $3::boolean) and s.device_id = $2",
      [phones, device, Boolean(cleanupDevice)]
    );
    for (const row of recovered.rows) accountIds.add(row.id);
    const ids = [...accountIds];
    const recoveredShops = await client.query(
      "select business_id from business_memberships where user_id in (select id from users where account_id = any($1::uuid[]))",
      [ids]
    );
    for (const row of recoveredShops.rows) businessIds.add(row.business_id);
    const businesses = [...businessIds];
    const users = (
      await client.query("select id from users where account_id = any($1::uuid[])", [ids])
    ).rows.map((row) => row.id);
    const tables = (
      await client.query(
        "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'record' and table_name like 'cp2_%' order by table_name"
      )
    ).rows.map((row) => row.table_name);
    const allColumns = (
      await client.query(
        "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'cp2_%'"
      )
    ).rows;
    await client.query(
      "create temporary table grogoni_edge_smoke_ids (kind text, id text) on commit drop"
    );
    await client.query(
      "insert into grogoni_edge_smoke_ids select 'account', unnest($1::text[]) union all select 'business', unnest($2::text[]) union all select 'user', unnest($3::text[])",
      [ids, businesses, users]
    );
    const deletions = [];
    // Remove descendants before their runtime-binding and business parents.
    const priority = [
      "cp2_conversation_messages",
      "cp2_conversation_attachments",
      "cp2_conversations",
      "cp2_native_runtime_bindings",
      "cp2_native_execution_hosts",
      "cp2_native_runtime_models",
      "cp2_native_runtime_agents"
    ];
    for (const table of [
      ...priority.filter((table) => tables.includes(table)),
      ...tables.filter((table) => !priority.includes(table))
    ]) {
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error("Invalid schema table name.");
      const columns = new Set(
        allColumns.filter((row) => row.table_name === table).map((row) => row.column_name)
      );
      const conditions = [
        columns.has("account_id")
          ? "account_id::text in (select id from grogoni_edge_smoke_ids where kind = 'account')"
          : "false",
        columns.has("business_id")
          ? "business_id::text in (select id from grogoni_edge_smoke_ids where kind = 'business')"
          : "false",
        columns.has("user_id")
          ? "user_id::text in (select id from grogoni_edge_smoke_ids where kind = 'user')"
          : "false",
        columns.has("entity_id")
          ? "entity_id::text in (select id from grogoni_edge_smoke_ids)"
          : "false"
      ];
      deletions.push(`delete from ${table} where (${conditions.join(" or ")});`);
    }
    await client.query(deletions.join("\n"));
    for (const table of ["products", "business_memberships"])
      await client.query(`delete from ${table} where business_id = any($1::uuid[])`, [businesses]);
    await client.query("delete from businesses where id = any($1::uuid[])", [businesses]);
    for (const table of [
      "account_sync_changes",
      "auth_audit_events",
      "sessions",
      "account_identities",
      "password_credentials",
      "account_pin_hashes",
      "mfa_factors",
      "recovery_codes"
    ])
      await client.query(`delete from ${table} where account_id = any($1::uuid[])`, [ids]);
    await client.query("delete from users where account_id = any($1::uuid[])", [ids]);
    await client.query("delete from accounts where id = any($1::uuid[])", [ids]);
    await client.query("commit");
    console.log("PASS disposable business fixtures removed");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

function smokePdf() {
  const text = "BT /F1 12 Tf 72 720 Td (Edge PDF smoke) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
