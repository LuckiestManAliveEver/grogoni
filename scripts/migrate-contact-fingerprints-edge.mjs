/** Run the fingerprint migration with the existing deployed key, without downloading it.
 * Dry-run by default. A temporary authenticated function is deleted in finally.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Blob } from "node:buffer";
const project = "gnmndzsughifhboqvsgd";
const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required.");
const apply = process.argv.includes("--apply");
const slug = `contact-migration-${randomUUID().slice(0, 8)}`;
const invocationToken = randomBytes(32).toString("hex");
const digest = createHash("sha256").update(invocationToken).digest("hex");
async function management(path, options = {}) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: globalThis.AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`Management request HTTP ${response.status}`);
  return response;
}
const source = `
import pg from "npm:pg@8.22.0";
import { Buffer } from "node:buffer";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
Deno.serve(async request => {
 const supplied = createHash("sha256").update(request.headers.get("x-migration-token") ?? "").digest("hex");
 if (!timingSafeEqual(Buffer.from(supplied),Buffer.from(${JSON.stringify(digest)}))) return new Response(null,{status:403});
 if (request.method !== "POST") return new Response(null,{status:405});
 const apply = (await request.json()).apply === true;
 const key = Deno.env.get("CONTACT_DISCOVERY_HMAC_SECRET") ?? Deno.env.get("AUTH_AUDIT_HMAC_SECRET");
 if (!key) return Response.json({code:"migration_key_missing"},{status:503});
 const url = new URL(Deno.env.get("DATABASE_URL"));
 if (!["localhost","127.0.0.1"].includes(url.hostname)) url.searchParams.set("sslmode","verify-full");
 const client = new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000,statement_timeout:30000});
 try {
  await client.connect(); await client.query("begin");
  await client.query("set local lock_timeout = '10s'");
  await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
  const rows = await client.query("select entity_id, record from cp2_contact_hashes where record->>'hashType' in ('phone','email') and record->>'hashValue' ~ '^[a-f0-9]{64}$' for update");
  if(apply) for(const row of rows.rows){
   const record = {...row.record,hashValue:"hmac-v1:"+createHmac("sha256",key).update("grogoni:contact-discovery:v1:"+row.record.hashType+":"+row.record.hashValue).digest("hex")};
   await client.query("update cp2_contact_hashes set record=$2::jsonb where entity_id=$1",[row.entity_id,JSON.stringify(record)]);
  }
  await client.query(apply?"commit":"rollback");
  return Response.json({mode:apply?"applied":"dry-run",fingerprints:rows.rowCount,identifiersLogged:false});
 }catch(error){
  await client.query("rollback").catch(()=>{});
  return Response.json({code:"migration_failed",databaseCode:/^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : null},{status:500});
 }finally{await client.end().catch(()=>{});}
});`;
const form = new globalThis.FormData();
form.append(
  "metadata",
  JSON.stringify({ name: slug, entrypoint_path: "index.ts", verify_jwt: false })
);
form.append("file", new Blob([source], { type: "application/typescript" }), "index.ts");
let attempted = false;
try {
  attempted = true;
  await management(`/functions/deploy?slug=${slug}`, { method: "POST", body: form });
  const response = await fetch(`https://${project}.supabase.co/functions/v1/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-migration-token": invocationToken },
    body: JSON.stringify({ apply }),
    signal: globalThis.AbortSignal.timeout(90000)
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `Migration request HTTP ${response.status}; code ${result.code ?? "unknown"}; database code ${result.databaseCode ?? "unknown"}`
    );
  console.log(JSON.stringify(result));
} finally {
  if (attempted) {
    await management(`/functions/${slug}`, { method: "DELETE" });
    console.log(JSON.stringify({ temporaryFunctionDeleted: true }));
  }
}
