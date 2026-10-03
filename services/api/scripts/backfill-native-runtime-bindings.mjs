#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function planNativeRuntimeBackfill(input) {
  const actions = [];
  const ambiguous = [];
  const conflicts = [];
  const skipped = [];
  const activeByAgent = new Map();
  const modelMetadata = new Map(
    (input.nativeRuntimeModels ?? []).map((envelope) => {
      const model = envelope.record ?? envelope;
      return [model.id, model];
    })
  );

  for (const envelope of input.agentModelBindings ?? []) {
    const binding = envelope.record ?? envelope;
    if (binding.status !== "active" || binding.lastVerificationStatus !== "passed") {
      skipped.push({
        source: "agent-model-binding",
        id: binding.id,
        reason: "not-active-and-verified"
      });
      continue;
    }
    const existing = activeByAgent.get(binding.agentId);
    if (existing !== undefined) {
      conflicts.push({
        source: "agent-model-binding",
        agentId: binding.agentId,
        ids: [existing.id, binding.id],
        reason: "multiple-active-bindings"
      });
      continue;
    }
    activeByAgent.set(binding.agentId, binding);
  }

  for (const binding of activeByAgent.values()) {
    const timestamp = binding.updatedAt ?? binding.activatedAt ?? new Date(0).toISOString();
    const nativeBindingId = `native:legacy:${binding.id}`;
    const primaryTarget = normalizeLegacyExecutionTarget(binding.executionTarget);
    const primaryHostId = stableUuid(
      `native-runtime-host:${binding.accountId}:${binding.shopId}:${primaryTarget}`
    );
    actions.push(
      action("agent", binding.agentId, {
        id: binding.agentId,
        businessId: binding.shopId,
        accountId: binding.accountId,
        name: "Grogoni business agent",
        provider: "grogoni-business-agent",
        packageRef: null,
        version: "1",
        runtimeContractVersion: "1",
        capabilities: ["tools", "mcp"],
        configuration: { requiredModelCapabilities: ["tool-routing"] },
        status: "active",
        createdAt: binding.createdAt ?? timestamp,
        updatedAt: timestamp
      }),
      modelAction(
        binding.modelId,
        primaryTarget,
        timestamp,
        modelMetadata.get(binding.modelId)?.provider
      ),
      hostAction(primaryHostId, binding, primaryTarget, timestamp),
      installationAction(binding.modelId, primaryHostId, timestamp),
      action("binding", nativeBindingId, {
        id: nativeBindingId,
        businessId: binding.shopId,
        accountId: binding.accountId,
        agentId: binding.agentId,
        name: "Migrated agent runtime",
        status: "active",
        isDefault: false,
        configuration: { source: "cp2_agent_model_bindings", legacyBindingId: binding.id },
        runtimeContractVersion: "1",
        createdAt: binding.createdAt ?? timestamp,
        updatedAt: timestamp,
        updatedBy: binding.updatedBy ?? "migration"
      }),
      roleAction(nativeBindingId, binding.modelId, "primary", 0, primaryHostId, timestamp)
    );
    if (binding.fallbackModelId) {
      const persistedFallbackTarget = modelMetadata.get(binding.fallbackModelId)?.configuration
        ?.executionTarget;
      const fallbackTarget = normalizeLegacyExecutionTarget(persistedFallbackTarget ?? "backend");
      const fallbackHostId = stableUuid(
        `native-runtime-host:${binding.accountId}:${binding.shopId}:${fallbackTarget}`
      );
      actions.push(
        modelAction(
          binding.fallbackModelId,
          fallbackTarget,
          timestamp,
          modelMetadata.get(binding.fallbackModelId)?.provider
        ),
        hostAction(fallbackHostId, binding, fallbackTarget, timestamp),
        installationAction(binding.fallbackModelId, fallbackHostId, timestamp),
        roleAction(
          nativeBindingId,
          binding.fallbackModelId,
          "fallback",
          0,
          fallbackHostId,
          timestamp
        )
      );
    }
  }

  for (const envelope of input.modelPreferences ?? []) {
    const preference = envelope.record ?? envelope;
    const timestamp = preference.updatedAt ?? preference.createdAt ?? new Date(0).toISOString();
    const accountId = envelope.account_id ?? envelope.accountId ?? null;
    const businessId = envelope.business_id ?? envelope.businessId ?? preference.tenantId ?? null;
    const agentId = `native:retired-preference-agent:${preference.id}`;
    const bindingId = `native:retired-preference:${preference.id}`;
    const preferred = uniqueStrings(preference.preferredModelIds);
    const fallback = uniqueStrings(preference.fallbackModelIds).filter(
      (modelId) => !preferred.includes(modelId)
    );
    actions.push(
      action("agent", agentId, {
        id: agentId,
        businessId,
        accountId,
        name: `Retired ${preference.scope} preference holder`,
        provider: "grogoni-migrated-preference",
        packageRef: null,
        version: "1",
        runtimeContractVersion: "1",
        capabilities: [],
        configuration: {
          requiredModelCapabilities: uniqueStrings(preference.requiredCapabilities)
        },
        status: "inactive",
        createdAt: preference.createdAt ?? timestamp,
        updatedAt: timestamp
      }),
      action("binding", bindingId, {
        id: bindingId,
        businessId,
        accountId,
        agentId,
        name: "Archived Execution Fabric preference",
        status: "draft",
        isDefault: false,
        configuration: {
          source: "retired-execution-fabric-preference",
          legacyPreferenceId: preference.id,
          legacyScope: preference.scope,
          legacyScopeId: preference.scopeId,
          executionPreference: preference.executionPreference ?? null,
          qualityPreference: preference.qualityPreference ?? null,
          allowCloudFallback: preference.allowCloudFallback ?? false,
          maxCostPerRequest: preference.maxCostPerRequest ?? null,
          maxLatencyMs: preference.maxLatencyMs ?? null,
          minimumContextWindow: preference.minimumContextWindow ?? null
        },
        runtimeContractVersion: "1",
        createdAt: preference.createdAt ?? timestamp,
        updatedAt: timestamp,
        updatedBy: preference.updatedBy ?? "migration"
      })
    );
    const orderedModels = [...preferred, ...fallback];
    for (const [index, modelId] of orderedModels.entries()) {
      const role = index === 0 ? "primary" : "fallback";
      const priority = role === "primary" ? 0 : index - 1;
      actions.push(
        modelAction(modelId, "retired-fabric", timestamp, modelMetadata.get(modelId)?.provider),
        roleAction(bindingId, modelId, role, priority, null, timestamp)
      );
    }
    if (orderedModels.length === 0) {
      skipped.push({
        source: "model-preference",
        id: preference.id,
        reason: "archived-without-model-roles"
      });
    }
  }

  for (const envelope of input.runtimeHosts ?? []) {
    const host = envelope.record ?? envelope;
    const timestamp = host.updatedAt ?? host.createdAt ?? new Date(0).toISOString();
    actions.push(
      action("host", host.id, {
        id: host.id,
        businessId: envelope.business_id ?? envelope.businessId ?? null,
        accountId: envelope.account_id ?? envelope.accountId ?? host.accountId ?? null,
        type: "retired-fabric-host",
        name: host.name ?? "Retired Execution Fabric host",
        endpoint: null,
        status: "unavailable",
        capabilities: uniqueStrings(host.declaredRuntimes),
        configuration: {
          source: "retired-execution-fabric-host",
          legacyTrustLevel: host.trustLevel ?? null,
          legacyBrokerNodeId: host.brokerNodeId ?? null,
          legacyMaxConcurrentJobs: host.maxConcurrentJobs ?? null
        },
        credentialReference: null,
        lastKnownHealthyAt: null,
        createdAt: host.createdAt ?? timestamp,
        updatedAt: timestamp
      })
    );
  }

  for (const envelope of input.runtimeModelInstallations ?? []) {
    const installation = envelope.record ?? envelope;
    const timestamp =
      installation.updatedAt ?? installation.installedAt ?? new Date(0).toISOString();
    actions.push(
      modelAction(
        installation.modelId,
        "retired-fabric",
        timestamp,
        modelMetadata.get(installation.modelId)?.provider
      ),
      action("installation", installation.id, {
        id: installation.id,
        modelId: installation.modelId,
        executionHostId: installation.runtimeHostId,
        status: "unavailable",
        configuration: {
          source: "retired-execution-fabric-installation",
          legacyStatus: installation.status ?? null
        },
        lastKnownHealthyAt: null,
        createdAt: installation.installedAt ?? timestamp,
        updatedAt: timestamp
      })
    );
  }

  const deduped = new Map();
  for (const item of actions) deduped.set(`${item.kind}:${item.id}`, item);
  return { actions: [...deduped.values()], ambiguous, conflicts, skipped };
}

function action(kind, id, record) {
  return { kind, id, record };
}

function uniqueStrings(value) {
  return [...new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : [])];
}

function modelAction(modelId, executionTarget, timestamp, provider) {
  return action("model", modelId, {
    id: modelId,
    name: modelId,
    provider: typeof provider === "string" && provider !== "" ? provider : "legacy",
    providerModelId: modelId,
    runtimeContractVersion: "1",
    capabilities: ["chat", "tool-routing"],
    configuration: { source: "legacy-binding", executionTarget },
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function hostAction(id, binding, executionTarget, timestamp) {
  return action("host", id, {
    id,
    businessId: binding.shopId,
    accountId: binding.accountId,
    type: executionTarget,
    name: `${executionTarget} runtime`,
    endpoint: null,
    status: "available",
    capabilities: [executionTarget],
    configuration: { executionTarget, source: "verified-legacy-binding" },
    credentialReference: null,
    lastKnownHealthyAt: binding.lastVerifiedAt,
    createdAt: binding.createdAt ?? timestamp,
    updatedAt: timestamp
  });
}

function normalizeLegacyExecutionTarget(executionTarget) {
  return executionTarget === "openai" ? "backend" : executionTarget;
}

function installationAction(modelId, hostId, timestamp) {
  const id = stableUuid(`native-runtime-installation:${modelId}:${hostId}`);
  return action("installation", id, {
    id,
    modelId,
    executionHostId: hostId,
    status: "available",
    configuration: { source: "verified-legacy-binding" },
    lastKnownHealthyAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function roleAction(bindingId, modelId, role, priority, hostId, timestamp) {
  const id = stableUuid(`native-runtime-role:${bindingId}:${role}:${priority}:${modelId}`);
  return action("role", id, {
    id,
    runtimeBindingId: bindingId,
    modelId,
    role,
    priority,
    executionHostId: hostId,
    configuration: {},
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function stableUuid(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4];
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

async function readSources(client) {
  const bindings = await client.query(
    "select record, business_id, account_id from cp2_agent_model_bindings order by entity_id"
  );
  const preferences = await readRetiredSource(client, "cp2_model_preferences");
  const runtimeHosts = await readRetiredSource(client, "cp2_runtime_hosts");
  const runtimeModelInstallations = await readRetiredSource(
    client,
    "cp2_runtime_model_installations"
  );
  const nativeRuntimeModels = await client.query(
    "select record, business_id, account_id from cp2_native_runtime_models order by entity_id"
  );
  return {
    agentModelBindings: bindings.rows,
    nativeRuntimeModels: nativeRuntimeModels.rows,
    modelPreferences: preferences,
    runtimeHosts,
    runtimeModelInstallations
  };
}

async function readRetiredSource(client, tableName) {
  const exists = await client.query("select to_regclass($1) as table_name", [
    `public.${tableName}`
  ]);
  if (exists.rows[0]?.table_name === null) return [];
  const records = await client.query(
    `select record, business_id, account_id from ${tableName} order by entity_id`
  );
  return records.rows;
}

const tableForKind = {
  agent: "cp2_native_runtime_agents",
  model: "cp2_native_runtime_models",
  host: "cp2_native_execution_hosts",
  installation: "cp2_native_model_installations",
  binding: "cp2_native_runtime_bindings",
  role: "cp2_native_runtime_binding_models"
};

async function applyPlan(client, plan) {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.native_runtime_backfill'))");
    await client.query("set constraints all deferred");
    for (const item of plan.actions) {
      const table = tableForKind[item.kind];
      const record = item.record;
      const parentId =
        item.kind === "installation"
          ? record.executionHostId
          : item.kind === "binding"
            ? record.agentId
            : item.kind === "role"
              ? record.runtimeBindingId
              : null;
      await client.query(
        `insert into ${table} (entity_id, business_id, account_id, parent_id, record, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, now())
         on conflict (entity_id) do update set
           business_id = excluded.business_id, account_id = excluded.account_id,
           parent_id = excluded.parent_id, record = excluded.record, updated_at = now()`,
        [
          item.id,
          record.businessId ?? null,
          record.accountId ?? null,
          parentId,
          JSON.stringify(record)
        ]
      );
    }
    for (const item of plan.actions.filter(
      (candidate) => candidate.kind === "binding" && candidate.record.status === "active"
    )) {
      await client.query(
        `update cp2_conversations set record = jsonb_set(record, '{runtimeBindingId}', to_jsonb($1::text), true)
         where business_id = $2 and account_id = $3`,
        [item.id, item.record.businessId, item.record.accountId]
      );
      await client.query(
        `update conversations set runtime_binding_id = $1
         where active_shop_id::text = $2 and account_id::text = $3`,
        [item.id, item.record.businessId, item.record.accountId]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export function formatBackfillReport(plan, dryRun) {
  return JSON.stringify(
    {
      dryRun,
      createsOrUpdates: plan.actions,
      ambiguousMappings: plan.ambiguous,
      conflicts: plan.conflicts,
      skipped: plan.skipped
    },
    null,
    2
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const plan = planNativeRuntimeBackfill(await readSources(client));
    console.log(formatBackfillReport(plan, dryRun));
    if (dryRun) return;
    if (plan.conflicts.length > 0 || plan.ambiguous.length > 0) {
      throw new Error(
        "Backfill has conflicts or ambiguous mappings; resolve them before applying."
      );
    }
    await applyPlan(client, plan);
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
