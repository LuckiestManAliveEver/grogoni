import { createHash } from "node:crypto";
import { escapeLiteral, type PoolClient } from "pg";
import type { Cp2Snapshot } from "./store.js";
import {
  createChannelGatewayFromEnvironment,
  type CanonicalInboundChannelMessage
} from "../messaging/channel-gateway.js";

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
const runtimeTaskCollections = new Set<keyof Cp2Snapshot>([
  "runtimeHandoffs",
  "runtimeTaskHeads",
  "runtimeTaskInstances",
  "runtimeTransfers",
  "runtimeExecutionEvents"
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
  // A provider callback has no browser session. Resolve only authenticated sender
  // accounts, linked threads, or one-time customer grants into its tenant scope.
  const webhookProvider =
    request.method === "POST"
      ? path.match(
          /^\/v1\/webhooks\/channels\/(telegram|whatsapp|messenger|instagram|tiktok|x|sms)$/
        )?.[1]
      : undefined;
  let inbound: CanonicalInboundChannelMessage[] = [];
  if (webhookProvider && payload) {
    try {
      inbound = createChannelGatewayFromEnvironment().normalizeInboundBatch({
        provider: webhookProvider as CanonicalInboundChannelMessage["provider"],
        headers: Object.fromEntries(request.headers),
        payload: input,
        rawBody: payload
      });
    } catch {
      /* The route returns the provider's authentication/validation error. */
    }
  }
  const webhookBusinesses = inbound.flatMap((message) =>
    message.businessId ? [message.businessId] : []
  );
  const webhookThreads = inbound.map((message) => message.externalConversationId);
  const webhookGrants = inbound.flatMap((message) =>
    message.linkToken ? [createHash("sha256").update(message.linkToken).digest("hex")] : []
  );
  const sqlList = (values: string[]) =>
    values.length ? values.map(escapeLiteral).join(",") : "null";
  const webhookScope = inbound.length
    ? `
      union select business_id from public.conversation_channels where record->>'provider' = ${escapeLiteral(webhookProvider!)} and record->>'externalConversationId' in (${sqlList(webhookThreads)})
      union select business_id from public.channel_identity_link_grants where record->>'provider' = ${escapeLiteral(webhookProvider!)} and record->>'tokenHash' in (${sqlList(webhookGrants)}) and (record->>'expiresAt')::timestamptz > now()
      union select id::text from public.businesses where id::text in (${sqlList(webhookBusinesses)})`
    : "";
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
       union all select t.account_id::uuid, u.id from cp2_auth_transactions t join users u on u.account_id = t.account_id::uuid
         where t.entity_id = $5::text and t.record->>'purpose' in ('login_mfa', 'recovery')
           and t.record->>'consumedAt' is null and (t.record->>'expiresAt')::timestamptz > now() and (t.record->>'attempts')::int < 5
       union all select i.account_id, u.id from account_identities i join users u on u.account_id = i.account_id
         where i.type = 'email' and i.normalized_value = $6 and i.verified_at is not null
     ) select a.id as account_id, u.id as user_id, a.primary_auth_destination
       from candidates c join accounts a on a.id = c.account_id
       join users u on u.id = c.user_id and u.account_id = a.id
       where a.status = 'active' and a.deleted_at is null limit 1`,
      [
        sessionId && uuid.test(sessionId) ? sessionId : null,
        createHash("sha256").update(bearer).digest("hex"),
        credential,
        path === "/oauth/token" ? codeHash : "",
        /^\/auth\/(?:mfa\/(?:email\/challenge|verify)|recovery\/(?:verify|reset-password))$/.test(
          path
        ) &&
        typeof input.transactionId === "string" &&
        uuid.test(input.transactionId)
          ? input.transactionId
          : null,
        path === "/auth/recovery/start" &&
        input.type === "email" &&
        typeof input.identifier === "string"
          ? input.identifier.trim().toLowerCase()
          : ""
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
      ${webhookScope}
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
    `select * from public.otp_challenges where id::text = ${challenge}
      or id::text in (select record->>'providerChallengeId' from public.cp2_auth_transactions
        where entity_id = ${escapeLiteral(typeof input.transactionId === "string" ? input.transactionId : "")}
        and account_id = nullif(${actorAccount}, '') and record->>'consumedAt' is null and (record->>'expiresAt')::timestamptz > now())`
  ]);
  return {
    accountId: actor?.account_id as string | undefined,
    withClause: `with ${ctes.map(([name, sql]) => `${name} as (${sql})`).join(",\n")}`,
    predicate(key: keyof Cp2Snapshot) {
      if (globalCollections.has(key)) return "true";
      // Runtime task records carry taskId rather than tenant columns. Omitting their
      // head resets checkpoint allocation to version 1 on the next Edge request.
      if (runtimeTaskCollections.has(key))
        return "record->>'taskId' in (select id from edge_conversation_ids)";
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
      if (key === "otpChallenges") return "entity_id in (select id::text from otp_challenges)";
      if (key === "oauthSessions") return "entity_id in (select id::text from oauth_sessions)";
      if (key === "accounts") return "entity_id in (select id from edge_account_ids)";
      if (key === "users") return "entity_id in (select id from edge_user_ids)";
      if (key === "businesses" || key === "shopPresences")
        return "entity_id in (select id from edge_business_ids)";
      if (key === "networkNodes")
        return `user_id = nullif(${actorUser}, '') or entity_id in (select id from edge_recipient_node_ids)`;
      if (key === "statusBroadcasts")
        return "business_id in (select id from edge_business_ids) or entity_id in (select id from edge_received_status_ids)";
      if (key === "passkeyCeremonies")
        return `entity_id = ${escapeLiteral(ceremony)} or account_id = nullif(${actorAccount}, '')`;
      return `${key === "nativeRuntimeAgents" || key === "nativeRuntimeBindings" ? "(account_id is null and business_id is null and user_id is null) or " : key === "nativeExecutionHosts" ? "entity_id in (select id from edge_runtime_host_ids) or " : ""}(account_id = ${actorAccount} and ${actorAccount} <> '')
        or business_id in (select id from edge_business_ids)
        or user_id in (select id from edge_user_ids)
        or parent_id in (select id from edge_parent_ids)
        ${conversationChildren.has(key) ? "or record->>'conversationId' in (select id from edge_conversation_ids)" : ""}
        ${key === "networkInvites" ? `or record->>'fromUserId' = nullif(${actorUser}, '') or record->>'toUserId' = nullif(${actorUser}, '')` : ""}
        ${key === "staffInvitations" ? `or record->>'destination' = nullif(${destination}, '')` : ""}`;
    }
  };
}

export function prepareEdgeHydration(snapshot: Cp2Snapshot): Cp2Snapshot {
  const hydrated = structuredClone(snapshot);
  const watermark = (snapshot.offlineMetadata ?? []).reduce(
    (max, entry) => Math.max(max, entry.sequence),
    0
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
