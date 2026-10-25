import { createHash } from "node:crypto";
import { escapeLiteral, type PoolClient } from "pg";
import { retainedRuntimeCheckpointSql } from "./domains/runtime-handoff/checkpoint-retention.js";
import { runtimeOperationDedupCutoffSql } from "./domains/runtime-handoff/operation-dedup-retention.js";
import type { Cp2Snapshot } from "./store.js";

const globalCollections = new Set<keyof Cp2Snapshot>([
  "modelCatalog",
  "agentCatalog",
  "platformOperators"
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const conversationChildren = new Set<keyof Cp2Snapshot>([
  "conversationParticipants",
  "conversationMessages",
  "conversationAttachments",
  "conversationChannels",
  "messageDeliveryAttempts",
  "messageNotificationDeliveries"
]);

/**
 * Runtime checkpoint rows carry no tenant columns: they belong to a task, and a task id is a
 * conversation id. They load with the conversations the caller works in
 * (edge_task_conversation_ids); checkpoints load only while they are kept (see the predicate).
 * Without this every
 * later agent turn in a conversation saw no checkpoint, bootstrapped version 1 again, and failed
 * on cp2_runtime_handoffs_task_version_idx (23505), answering 503 to the second message.
 */
const taskColumn = new Map<keyof Cp2Snapshot, string>([
  ["runtimeHandoffs", "task_id"],
  ["runtimeTransfers", "task_id"],
  ["runtimeExecutionEvents", "task_id"],
  ["runtimeTaskHeads", "entity_id"],
  ["runtimeTaskInstances", "entity_id"]
]);

/** CTEs shadow only loader reads. Persistence always targets the real tables by explicit IDs. */
export async function createEdgeSnapshotScope(
  client: PoolClient,
  request: Request,
  path: string,
  payload?: Buffer
) {
  const sessionId =
    (request.headers.get("cookie") ?? "").match(
      /(?:^|;\s*)grogoni_session=([a-f0-9-]{36})(?:;|$)/i
    )?.[1] ?? null;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  let input: Record<string, unknown> = {};
  if (payload && request.headers.get("content-type")?.includes("application/json")) {
    try {
      input = JSON.parse(payload.toString());
    } catch {
      /* Original route returns validation errors. */
    }
  } else if (
    payload &&
    request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
  ) {
    input = Object.fromEntries(new URLSearchParams(payload.toString()));
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const publicAgent = path.match(/^\/public\/storefronts\/([^/]+)/)?.[1];
  const recipient = typeof input.recipient === "string" ? input.recipient : "";
  const credential =
    input.response && typeof input.response === "object" && "id" in input.response
      ? String(input.response.id)
      : "";
  const ceremony = typeof input.ceremonyId === "string" ? input.ceremonyId : "";
  const codeHash = createHash("sha256")
    .update(typeof input.code === "string" ? input.code : "")
    .digest("hex");
  const callbackState =
    typeof input.state === "string" ? input.state : new URL(request.url).searchParams.get("state");
  const oauthStateHash = escapeLiteral(
    /^\/(?:api\/)?auth\/oauth\/(?:callback|[^/]+\/callback)$/.test(path) && callbackState
      ? createHash("sha256").update(callbackState).digest("hex")
      : ""
  );
  const dedupTask = requestedRuntimeTask(path, input);
  const businessId =
    path.match(/^\/businesses\/([^/]+)/)?.[1] ??
    (typeof input.businessId === "string" ? input.businessId : null);
  const actor = (
    await client.query(
      `with candidates as (
       select account_id, user_id from sessions where id = $1::uuid and revoked_at is null
         and expires_at > now() and absolute_expires_at > now() and inactivity_expires_at > now()
       union all select account_id, user_id from mcp_access_tokens where token_hash = $2
         and revoked_at is null and expires_at > now()
       union all select p.account_id::uuid, u.id from cp2_passkeys p join users u on u.account_id = p.account_id::uuid where p.entity_id = $3
       union all select s.account_id, s.user_id from cp2_edge_protocol_state p
         cross join lateral jsonb_array_elements(coalesce(p.record->'authorizationCodes', '[]'::jsonb)) code_grant
         join sessions s on s.id = (code_grant->1->>'sessionId')::uuid
         where p.entity_id = 'mcp' and code_grant->>0 = $4
     ) select a.id as account_id, u.id as user_id, a.primary_auth_destination
       from candidates c join accounts a on a.id = c.account_id
       join users u on u.id = c.user_id and u.account_id = a.id
       where a.status = 'active' and a.deleted_at is null limit 1`,
      [
        sessionId && uuid.test(sessionId) ? sessionId : null,
        createHash("sha256").update(bearer).digest("hex"),
        credential,
        path === "/oauth/token" ? codeHash : ""
      ]
    )
  ).rows[0];
  const actorAccount = escapeLiteral(actor?.account_id ?? "");
  const actorUser = escapeLiteral(actor?.user_id ?? "");
  const destination = escapeLiteral(actor?.primary_auth_destination ?? "");
  const requestedBusiness = escapeLiteral(businessId && uuid.test(businessId) ? businessId : "");
  const storefront = escapeLiteral(publicAgent ? decodeURIComponent(publicAgent) : recipient);
  const search = escapeLiteral(
    new URL(request.url).searchParams.get("query")?.trim().slice(0, 120) ?? ""
  );
  const checkoutShops = Array.isArray(input.items)
    ? input.items.flatMap((item) =>
        item && typeof item === "object" && typeof item.agentId === "string"
          ? [escapeLiteral(item.agentId)]
          : []
      )
    : [];
  const ctes: [string, string][] = [
    [
      "edge_recipient_node_ids",
      `select entity_id as id from public.cp2_network_nodes where record->>'grogoniUserId' = nullif(${actorUser}, '')`
    ],
    [
      "edge_received_status_ids",
      `select entity_id as id from public.status_broadcasts status where exists (
        select 1 from jsonb_array_elements(coalesce(status.record->'recipients', '[]'::jsonb)) recipient
        where recipient->>'networkNodeId' in (select id from edge_recipient_node_ids))`
    ],
    [
      "edge_business_ids",
      `select business_id::text as id from public.business_memberships where user_id = nullif(${actorUser}, '')::uuid
      union select id::text from public.businesses where id = nullif(${requestedBusiness}, '')::uuid
      union select business_id from public.cp2_staff_invitations where record->>'destination' = ${destination} and ${actorAccount} <> ''
      union select id::text from public.businesses where grogoni_id = ${storefront}
      ${checkoutShops.length ? `union select id::text from public.businesses where grogoni_id in (${checkoutShops.join(",")}) or id::text in (${checkoutShops.join(",")})` : ""}
      ${path === "/buy/search" ? `union select id from (select b.id::text as id from public.businesses b where position(lower(${search}) in lower(b.name)) > 0 or position(lower(${search}) in lower(b.grogoni_id)) > 0 or exists (select 1 from public.products p where p.business_id = b.id and position(lower(${search}) in lower(p.name)) > 0) order by b.name, b.id limit 50) searched_businesses` : ""}`
    ],
    [
      "edge_user_ids",
      `select id::text as id from public.users where account_id = nullif(${actorAccount}, '')::uuid
      union select user_id::text from public.business_memberships where business_id in (select id::uuid from edge_business_ids)
      union select u.id::text from public.users u join public.accounts a on a.id = u.account_id where a.primary_auth_destination = ${escapeLiteral(recipient)} and ${escapeLiteral(recipient)} <> ''`
    ],
    [
      "edge_account_ids",
      `select account_id::text as id from public.users where id in (select id::uuid from edge_user_ids)`
    ],
    [
      "edge_conversation_ids",
      `select entity_id as id from public.cp2_conversations where account_id = ${actorAccount}
      or business_id in (select id from edge_business_ids)
      union select record->>'conversationId' from public.cp2_conversation_participants where account_id = ${actorAccount} or user_id = ${actorUser}`
    ],
    [
      // Only conversations the caller works in: their own, ones they take part in, and those of
      // shops they are a member of. Not a viewed storefront's or a searched shop's: runtime
      // checkpoints and execution events grow with every agent turn and are none of a
      // visitor's business.
      "edge_task_conversation_ids",
      `select entity_id as id from public.cp2_conversations where account_id = ${actorAccount}
      or business_id in (select business_id::text from public.business_memberships where user_id = nullif(${actorUser}, '')::uuid)
      union select record->>'conversationId' from public.cp2_conversation_participants where account_id = ${actorAccount} or user_id = ${actorUser}`
    ],
    [
      "edge_parent_ids",
      `select id from edge_conversation_ids
      union select id from edge_business_ids union select id from edge_user_ids union select id from edge_account_ids
      union select id::text from public.purchase_receipts where business_id in (select id::uuid from edge_business_ids)
      union select id::text from public.invoices where business_id in (select id::uuid from edge_business_ids)`
    ]
  ];
  // Binding edges lack tenant columns. Follow only authorized bindings instead of
  // dropping their model graph or loading every other tenant's installations.
  ctes.push(
    [
      "edge_runtime_binding_ids",
      `select entity_id as id from public.cp2_native_runtime_bindings
       where (account_id is null and business_id is null and user_id is null)
       or account_id = nullif(${actorAccount}, '')
       or business_id in (select id from edge_business_ids)`
    ],
    [
      "edge_runtime_roles",
      `select record from public.cp2_native_runtime_binding_models
       where record->>'runtimeBindingId' in (select id from edge_runtime_binding_ids)`
    ],
    [
      "edge_runtime_host_ids",
      `select entity_id as id from public.cp2_native_execution_hosts
       where ((account_id is null and business_id is null and user_id is null)
       or account_id = nullif(${actorAccount}, '')
       or business_id in (select id from edge_business_ids))
       and entity_id in (select record->>'executionHostId' from edge_runtime_roles)`
    ]
  );
  const accountTables = [
    "sessions",
    "account_pin_hashes",
    "mcp_access_tokens",
    "cp2_external_registry_connections"
  ];
  const businessTables = [
    "products",
    "customers",
    "suppliers",
    "sales_agents",
    "supplier_contact_links",
    "receipt_ocr_jobs",
    "purchase_receipts",
    "invoices",
    "payments",
    "device_trust"
  ];
  ctes.push(
    [
      "oauth_sessions",
      `select * from public.oauth_sessions where account_id = nullif(${actorAccount}, '')::uuid
       or state_hash = nullif(${oauthStateHash}, '')`
    ],
    [
      "accounts",
      "select * from public.accounts where id in (select id::uuid from edge_account_ids)"
    ],
    ["users", "select * from public.users where id in (select id::uuid from edge_user_ids)"],
    [
      "businesses",
      "select * from public.businesses where id in (select id::uuid from edge_business_ids)"
    ],
    [
      "business_memberships",
      "select * from public.business_memberships where business_id in (select id::uuid from edge_business_ids) or user_id in (select id::uuid from edge_user_ids)"
    ],
    [
      "receipt_line_items",
      "select * from public.receipt_line_items where receipt_id in (select id::uuid from edge_parent_ids)"
    ],
    [
      "invoice_items",
      "select * from public.invoice_items where invoice_id in (select id::uuid from edge_parent_ids)"
    ],
    [
      "account_sync_changes",
      `select * from public.account_sync_changes where account_id = nullif(${actorAccount}, '')::uuid`
    ]
  );
  for (const table of accountTables)
    ctes.push([
      table,
      `select * from public.${table} where account_id = nullif(${actorAccount}, '')::uuid`
    ]);
  for (const table of businessTables)
    ctes.push([
      table,
      `select * from public.${table} where business_id in (select id::uuid from edge_business_ids)`
    ]);
  for (const table of ["user_identities"])
    ctes.push([
      table,
      `select * from public.${table} where user_id in (select id::uuid from edge_user_ids)`
    ]);
  // Unauthenticated challenge routes retain only the requested challenge, not everyone's OTPs.
  const challenge = escapeLiteral(typeof input.challengeId === "string" ? input.challengeId : "");
  ctes.push([
    "otp_challenges",
    `select * from public.otp_challenges where id::text = ${challenge}`
  ]);
  return {
    accountId: actor?.account_id as string | undefined,
    withClause: `with ${ctes.map(([name, sql]) => `${name} as (${sql})`).join(",\n")}`,
    predicate(key: keyof Cp2Snapshot) {
      if (globalCollections.has(key)) return "true";
      if (key === "nativeRuntimeBindingModels")
        return "record->>'runtimeBindingId' in (select id from edge_runtime_binding_ids)";
      if (key === "nativeRuntimeModels")
        return "entity_id in (select record->>'modelId' from edge_runtime_roles)";
      if (key === "nativeModelInstallations")
        return `record->>'executionHostId' in (select id from edge_runtime_host_ids)
          and exists (select 1 from edge_runtime_roles role
            where role.record->>'modelId' = cp2_native_model_installations.record->>'modelId'
            and role.record->>'executionHostId' = cp2_native_model_installations.record->>'executionHostId')`;
      if (key === "offlineMetadata")
        return "entity_id = 'server-sequence' or entity_id in (select 'business:' || id from edge_business_ids)";
      if (key === "oauthSessions") return "entity_id in (select id::text from oauth_sessions)";
      if (key === "accounts") return "entity_id in (select id from edge_account_ids)";
      if (key === "users") return "entity_id in (select id from edge_user_ids)";
      if (key === "businesses" || key === "shopPresences")
        return "entity_id in (select id from edge_business_ids)";
      if (key === "networkNodes")
        return `user_id = nullif(${actorUser}, '') or entity_id in (select id from edge_recipient_node_ids)`;
      if (key === "statusBroadcasts")
        return "business_id in (select id from edge_business_ids) or entity_id in (select id from edge_received_status_ids)";
      // Only the checkpoints a reader can still need (checkpoint-retention.ts), not every
      // checkpoint of every conversation the caller works in.
      if (key === "runtimeHandoffs")
        return `task_id in (select id from edge_task_conversation_ids)
          and ${retainedRuntimeCheckpointSql("cp2_runtime_handoffs")}`;
      // Idempotency records are keyed by the caller's account and task (withIdempotency), so
      // only the caller's own unexpired rows can ever match, and only the named task's when the
      // request names one.
      if (key === "runtimeOperationDedup")
        return `account_id = ${actorAccount} and ${actorAccount} <> ''
          and record->>'createdAt' >= ${runtimeOperationDedupCutoffSql}
          ${dedupTask === null ? "" : `and task_id = ${escapeLiteral(dedupTask)}`}`;
      if (key === "passkeyCeremonies")
        return `entity_id = ${escapeLiteral(ceremony)} or account_id = nullif(${actorAccount}, '')`;
      return `${key === "nativeRuntimeAgents" || key === "nativeRuntimeBindings" ? "(account_id is null and business_id is null and user_id is null) or " : key === "nativeExecutionHosts" ? "entity_id in (select id from edge_runtime_host_ids) or " : ""}(account_id = ${actorAccount} and ${actorAccount} <> '')
        or business_id in (select id from edge_business_ids)
        or user_id in (select id from edge_user_ids)
        or parent_id in (select id from edge_parent_ids)
        ${conversationChildren.has(key) ? "or record->>'conversationId' in (select id from edge_conversation_ids)" : ""}
        ${taskColumn.has(key) ? `or ${taskColumn.get(key)} in (select id from edge_task_conversation_ids)` : ""}
        ${key === "networkInvites" ? `or record->>'fromUserId' = nullif(${actorUser}, '') or record->>'toUserId' = nullif(${actorUser}, '')` : ""}
        ${key === "staffInvitations" ? `or record->>'destination' = nullif(${destination}, '')` : ""}`;
    }
  };
}

/**
 * The one task a request's idempotent runtime operation can run on: the `/v1/runtime/:taskId`
 * path, or the `taskId` argument of a single MCP tool call (or a plain JSON body). Null when the
 * request names none or several (a JSON-RPC batch): then every unexpired record of the account
 * loads.
 */
export function requestedRuntimeTask(path: string, input: Record<string, unknown>): string | null {
  const fromPath = path.match(/^\/v1\/runtime\/([^/]+)/)?.[1];
  if (fromPath !== undefined) {
    try {
      return decodeURIComponent(fromPath);
    } catch {
      return null;
    }
  }
  const params = input.params as { arguments?: { taskId?: unknown } } | undefined;
  const taskId = params?.arguments?.taskId ?? input.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

/**
 * Offline change sequence numbers are unique across every shop (cp2_offline_changes_sequence),
 * but a request loads only its own shops' changes and markers. `globalSequence` is the highest
 * sequence any shop has used (offlineSequenceHighWater): without it a shop allocated numbers
 * another shop already took and its write failed with 23505.
 */
export function prepareEdgeHydration(snapshot: Cp2Snapshot, globalSequence = 0): Cp2Snapshot {
  const hydrated = structuredClone(snapshot);
  const watermark = (snapshot.offlineMetadata ?? []).reduce(
    (max, entry) => Math.max(max, entry.sequence),
    globalSequence
  );
  hydrated.offlineMetadata = [
    {
      id: "server-sequence",
      sequence: (snapshot.offlineChanges ?? []).reduce(
        (max, entry) => Math.max(max, entry.sequence),
        watermark
      )
    }
  ];
  return hydrated;
}

export function prepareEdgePersistence(snapshot: Cp2Snapshot, baseline: Cp2Snapshot): Cp2Snapshot {
  const sequence = snapshot.offlineMetadata?.[0]?.sequence ?? 0;
  const metadata = new Map((baseline.offlineMetadata ?? []).map((entry) => [entry.id, entry]));
  const previousChanges = new Set((baseline.offlineChanges ?? []).map((entry) => entry.id));
  for (const change of snapshot.offlineChanges ?? []) {
    if (!previousChanges.has(change.id))
      metadata.set(`business:${change.businessId}`, {
        id: `business:${change.businessId}`,
        sequence
      });
  }
  snapshot.offlineMetadata = [...metadata.values()];
  return snapshot;
}

/** The highest offline change sequence any shop has used (one index lookup). */
export async function offlineSequenceHighWater(client: PoolClient): Promise<number> {
  const result = await client.query<{ sequence: string }>(
    `select (record->>'sequence')::bigint as sequence from cp2_offline_changes
     order by (record->>'sequence')::bigint desc limit 1`
  );
  return Number(result.rows[0]?.sequence ?? 0);
}

/**
 * Gives a request's new offline changes their final sequence numbers just before they are saved,
 * under a lock that every write creating offline changes takes, then reads the highest number in
 * use. Two shops writing at the same moment used to take the same next number (each request sees
 * only its own shops' changes) and the later commit failed with 23505. The lock is held only from
 * this point to commit, and only by requests that actually create offline changes. `assigned`
 * remembers the numbers given within this request, so a later save of the same request (whose
 * store still holds the provisional numbers) writes the same ones. Changes are standalone rows,
 * and a sync cursor a client already holds only gets lower than the final numbers, so it re-reads
 * them; it never skips one.
 */
export async function allocateOfflineSequences(
  client: PoolClient,
  next: Cp2Snapshot,
  previous: Cp2Snapshot,
  assigned: Map<string, number>
): Promise<void> {
  const known = new Set((previous.offlineChanges ?? []).map((change) => change.id));
  const changes = next.offlineChanges ?? [];
  for (const change of changes) {
    const sequence = assigned.get(change.id);
    if (sequence !== undefined) change.sequence = sequence;
  }
  const fresh = changes
    .filter((change) => !known.has(change.id) && !assigned.has(change.id))
    .sort((left, right) => left.sequence - right.sequence);
  if (fresh.length === 0) return;
  await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.offline_sequence'))");
  let sequence = await offlineSequenceHighWater(client);
  const metadata = new Map((next.offlineMetadata ?? []).map((entry) => [entry.id, entry]));
  for (const change of fresh) {
    sequence += 1;
    change.sequence = sequence;
    assigned.set(change.id, sequence);
    const key = `business:${change.businessId}`;
    metadata.set(key, { id: key, sequence: Math.max(metadata.get(key)?.sequence ?? 0, sequence) });
  }
  next.offlineMetadata = [...metadata.values()];
}

/**
 * Gives a request's new account sync journal rows (account_sync_changes) their final sequence
 * numbers just before they are saved. A request numbers them from what it loaded, which is safe
 * only while every writer of that account holds its account lock; the read marker, typing and
 * conversation settings routes no longer take that lock (edge-domain-routes.ts), and a write
 * also journals for other participants' accounts, which it never loads. Here, per account in a
 * fixed order, a lock held only from this point to commit (`edge:account-sync:<account>`) and
 * one index lookup of the highest stored number decide the numbers, so two writers never take the
 * same one (the journal's upsert would silently keep only the later row). Numbers only go up from
 * the provisional ones and commit in order, so a client cursor never skips a change. `assigned`
 * keeps the numbers given within this request for its later saves.
 */
export async function allocateAccountSyncSequences(
  client: PoolClient,
  next: Cp2Snapshot,
  previous: Cp2Snapshot,
  assigned: Map<string, number>
): Promise<void> {
  const known = new Set((previous.syncChanges ?? []).map((change) => change.cursor));
  for (const change of next.syncChanges ?? []) {
    const sequence = assigned.get(change.cursor);
    if (sequence !== undefined) change.sequence = sequence;
  }
  const fresh = (next.syncChanges ?? []).filter(
    (change) => !known.has(change.cursor) && !assigned.has(change.cursor)
  );
  if (fresh.length === 0) return;
  const byAccount = new Map<string, typeof fresh>();
  for (const change of fresh)
    byAccount.set(change.accountId, [...(byAccount.get(change.accountId) ?? []), change]);
  for (const accountId of [...byAccount.keys()].sort()) {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `edge:account-sync:${accountId}`
    ]);
    const stored = await client.query<{ sequence: string | null }>(
      "select max(sequence) as sequence from account_sync_changes where account_id = $1",
      [accountId]
    );
    let sequence = Number(stored.rows[0]?.sequence ?? 0);
    for (const change of byAccount.get(accountId)!.sort((a, b) => a.sequence - b.sequence)) {
      sequence += 1;
      change.sequence = sequence;
      assigned.set(change.cursor, sequence);
    }
  }
}
