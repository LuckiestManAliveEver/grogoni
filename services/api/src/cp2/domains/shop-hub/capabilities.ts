/**
 * The Shop Hub projection (GET /businesses/:businessId/capabilities). Everything a merchant sees
 * comes from the canonical registries in @grogoni/tool-core - tools join a module through their own
 * `hub` metadata - so a newly registered tool appears here with no change in this file or the web
 * app. This module only filters by role and attaches each module's setup state.
 */
import { roleCan, type BusinessPermission } from "@grogoni/business-core";
import type {
  BusinessRole,
  ShopCapabilitiesSummary,
  ShopCapabilityCategory
} from "@grogoni/shared-types";
import {
  runtimeToolRegistry,
  shopCategories,
  shopModuleRegistry,
  shopSetupChecks,
  type RuntimeToolDefinition,
  type ShopCategoryDefinition,
  type ShopModuleDefinition,
  type ShopModuleId,
  type ShopSetupCheckId,
  type ShopSetupState
} from "@grogoni/tool-core";

export interface ShopHubRegistries {
  tools: Readonly<Record<string, RuntimeToolDefinition>>;
  modules: Readonly<Record<ShopModuleId, ShopModuleDefinition>>;
  categories: readonly ShopCategoryDefinition[];
}

export const canonicalShopHubRegistries: ShopHubRegistries = {
  tools: runtimeToolRegistry,
  modules: shopModuleRegistry,
  categories: shopCategories
};

function roleHas(role: BusinessRole, permission: string): boolean {
  return roleCan(role, permission as BusinessPermission);
}

function visibleModules(role: BusinessRole, registries: ShopHubRegistries): ShopModuleDefinition[] {
  return Object.values(registries.modules).filter((module) => roleHas(role, module.viewPermission));
}

/** The setup checks worth running for this role: only those of modules it can see. */
export function setupChecksForRole(
  role: BusinessRole,
  registries: ShopHubRegistries = canonicalShopHubRegistries
): ShopSetupCheckId[] {
  return [
    ...new Set(
      visibleModules(role, registries).flatMap((module) =>
        module.setupCheck === null ? [] : [module.setupCheck]
      )
    )
  ];
}

export function buildShopCapabilities(input: {
  businessId: string;
  role: BusinessRole;
  setupStates: Partial<Record<ShopSetupCheckId, ShopSetupState>>;
  now: Date;
  registries?: ShopHubRegistries;
}): ShopCapabilitiesSummary {
  const registries = input.registries ?? canonicalShopHubRegistries;
  const modules = visibleModules(input.role, registries);
  const tools = Object.values(registries.tools).filter(
    (tool) => tool.hub !== null && roleHas(input.role, tool.requiredPermission)
  );

  const categories: ShopCapabilityCategory[] = registries.categories
    .map((category) => ({
      id: category.id,
      label: category.label,
      modules: modules
        .filter((module) => module.category === category.id)
        .map((module) => {
          const state: ShopSetupState =
            module.setupCheck === null
              ? "ready"
              : (input.setupStates[module.setupCheck] ?? "unavailable");
          const check = module.setupCheck === null ? null : shopSetupChecks[module.setupCheck];
          return {
            id: module.id,
            icon: module.icon,
            label: module.label,
            description: module.description,
            setup: {
              state,
              reason:
                check === null || state === "ready"
                  ? null
                  : state === "needs_setup"
                    ? check.needsSetup
                    : check.unavailable
            },
            tools: tools
              .filter((tool) => tool.hub?.module === module.id)
              .map((tool) => ({
                name: tool.name,
                label: tool.hub!.label,
                readOnly: tool.readOnly,
                requiresConfirmation: tool.requiresConfirmation,
                risk: tool.risk
              }))
          };
        })
    }))
    .filter((category) => category.modules.length > 0);

  return {
    businessId: input.businessId,
    role: input.role,
    categories,
    needsAttention: categories.flatMap((category) =>
      category.modules.flatMap((module) =>
        module.setup.state === "needs_setup" && module.setup.reason !== null
          ? [{ moduleId: module.id, label: module.label, reason: module.setup.reason }]
          : []
      )
    ),
    checkedAt: input.now.toISOString()
  };
}

export type ShopSetupCheckResolvers = Record<ShopSetupCheckId, () => Promise<ShopSetupState>>;

/**
 * Resolves the caller's role, runs the setup checks for the modules that role can see, and builds
 * the hub. A failing check degrades that one module to `unavailable`; it never fails the hub.
 */
export async function getShopCapabilities(input: {
  businessId: string;
  role: BusinessRole;
  checks: ShopSetupCheckResolvers;
  now: Date;
  registries?: ShopHubRegistries;
}): Promise<ShopCapabilitiesSummary> {
  const checkIds = setupChecksForRole(input.role, input.registries);
  const results = await Promise.all(
    checkIds.map(async (id) => {
      try {
        return [id, await input.checks[id]()] as const;
      } catch {
        return [id, "unavailable" as const] as const;
      }
    })
  );
  return buildShopCapabilities({
    businessId: input.businessId,
    role: input.role,
    setupStates: Object.fromEntries(results),
    now: input.now,
    ...(input.registries === undefined ? {} : { registries: input.registries })
  });
}
