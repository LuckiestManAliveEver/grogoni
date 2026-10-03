import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type { BusinessRole } from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

export interface BusinessActionDraft {
  actionType: string;
  actorId: string;
  aggregateId: string;
  aggregateType: string;
  requiresConfirmation: boolean;
}

export function validateBusinessActionDraft(draft: BusinessActionDraft): ValidationResult {
  const errors: string[] = [];

  if (draft.actionType.trim().length === 0) {
    errors.push("Action type is required.");
  }

  if (draft.actorId.trim().length === 0) {
    errors.push("Actor id is required.");
  }

  if (draft.aggregateId.trim().length === 0) {
    errors.push("Aggregate id is required.");
  }

  if (draft.aggregateType.trim().length === 0) {
    errors.push("Aggregate type is required.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function businessActionProposedEvent(input: {
  id: string;
  draft: BusinessActionDraft;
  occurredAt: string;
}): BusinessEvent<{ draft: BusinessActionDraft }> {
  return createEvent({
    id: input.id,
    type: "business_action.proposed",
    aggregateId: input.draft.aggregateId,
    aggregateType: input.draft.aggregateType,
    actorId: input.draft.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      draft: input.draft
    }
  });
}

export const businessRoles = [
  "owner",
  "manager",
  "sales_agent",
  "cashier",
  "view_only",
  "driver"
] as const;

export type BusinessPermission =
  | "business:create"
  | "business:read"
  // Agent-driven changes to the business's own operating surface: linking and unlinking network
  // identities, and isolated computer sessions (packages/tool-core registry). Held by the roles
  // with authority over the business - owner and manager.
  | "business:write"
  | "membership:read"
  | "membership:manage"
  // Staff invitations (docs/architecture/staff-invitations.md): invite people into the business
  // and manage their roles. Held by owner and manager; which roles each may grant or manage is
  // decided by `rolesGrantableBy` / `canManageMemberRole` below, never by comparing role names.
  | "membership:invite"
  | "product:read"
  | "product:write"
  | "customer:read"
  | "customer:write"
  | "supplier:read"
  | "supplier:write"
  | "inventory:adjust"
  | "invoice:read"
  | "invoice:write"
  | "invoice:confirm"
  | "payment:read"
  | "payment:write"
  | "logistics:read"
  | "logistics:write"
  // Corridor fulfillment (docs/architecture/corridor-fulfillment.md A8). `fulfillment:manage`
  // covers corridors, vehicles, policies and the business timezone; `fulfillment:dispatch` covers
  // manifests, vehicle assignment, approvals and corridor re-resolution; precise shop coordinates
  // are only readable with `shop_location:read_precise`.
  | "fulfillment:read"
  | "fulfillment:dispatch"
  | "fulfillment:manage"
  | "shop_location:write"
  | "shop_location:read_precise"
  | "delivery:record"
  | "import:read"
  | "import:write"
  | "report:read"
  | "notification:read"
  | "notification:write"
  | "compliance:read"
  | "compliance:export"
  | "compliance:delete"
  | "conversation:delete"
  | "verification:read"
  | "verification:write"
  | "tax:read"
  | "tax:write"
  | "device_trust:read"
  | "device_trust:write"
  | "beta:read"
  | "beta:write"
  | "beta:support"
  | "beta:telemetry"
  | "launch:read"
  | "launch:write"
  | "launch:support";

const rolePermissions: Record<BusinessRole, ReadonlySet<BusinessPermission>> = {
  owner: new Set([
    "business:create",
    "business:read",
    "business:write",
    "membership:read",
    "membership:manage",
    "membership:invite",
    "product:read",
    "product:write",
    "customer:read",
    "customer:write",
    "supplier:read",
    "supplier:write",
    "inventory:adjust",
    "invoice:read",
    "invoice:write",
    "invoice:confirm",
    "payment:read",
    "payment:write",
    "logistics:read",
    "logistics:write",
    "fulfillment:read",
    "fulfillment:dispatch",
    "fulfillment:manage",
    "shop_location:write",
    "shop_location:read_precise",
    "delivery:record",
    "import:read",
    "import:write",
    "report:read",
    "notification:read",
    "notification:write",
    "compliance:read",
    "compliance:export",
    "compliance:delete",
    "conversation:delete",
    "verification:read",
    "verification:write",
    "tax:read",
    "tax:write",
    "device_trust:read",
    "device_trust:write",
    "beta:read",
    "beta:write",
    "beta:support",
    "beta:telemetry",
    "launch:read",
    "launch:write",
    "launch:support"
  ]),
  manager: new Set([
    "business:read",
    "business:write",
    "membership:read",
    "membership:invite",
    "product:read",
    "product:write",
    "customer:read",
    "customer:write",
    "supplier:read",
    "supplier:write",
    "inventory:adjust",
    "invoice:read",
    "invoice:write",
    "invoice:confirm",
    "payment:read",
    "payment:write",
    "logistics:read",
    "logistics:write",
    "fulfillment:read",
    "fulfillment:dispatch",
    "shop_location:write",
    "shop_location:read_precise",
    "delivery:record",
    "import:read",
    "import:write",
    "report:read",
    "notification:read",
    "notification:write",
    "compliance:read",
    "verification:read",
    "tax:read",
    "tax:write",
    "device_trust:read",
    "beta:read",
    "beta:support",
    "beta:telemetry",
    "launch:read",
    "launch:support"
  ]),
  sales_agent: new Set([
    "business:read",
    "product:read",
    "customer:read",
    "customer:write",
    "invoice:read",
    "invoice:write",
    "payment:read",
    "logistics:read",
    "logistics:write",
    "fulfillment:read",
    "shop_location:write",
    "import:read",
    "notification:read",
    "tax:read",
    "beta:read",
    "beta:support",
    "beta:telemetry",
    "launch:read",
    "launch:support"
  ]),
  cashier: new Set([
    "business:read",
    "product:read",
    "customer:read",
    "invoice:read",
    "payment:read",
    "payment:write",
    "logistics:read",
    "import:read",
    "notification:read",
    "tax:read",
    "beta:read",
    "beta:support",
    "beta:telemetry",
    "launch:read",
    "launch:support"
  ]),
  view_only: new Set([
    "business:read",
    "product:read",
    "customer:read",
    "supplier:read",
    "tax:read",
    "beta:read",
    "launch:read"
  ]),
  // A business-scoped membership value (not a global role): a driver records delivery outcomes and
  // nothing else. Which manifests a driver may see is scoped to assignment (Phase 1c/2).
  driver: new Set(["business:read", "delivery:record"])
};

export function isBusinessRole(value: string): value is BusinessRole {
  return businessRoles.includes(value as BusinessRole);
}

export function roleCan(role: BusinessRole, permission: BusinessPermission): boolean {
  return rolePermissions[role]?.has(permission) ?? false;
}

export function permissionsForRole(role: BusinessRole): BusinessPermission[] {
  return [...(rolePermissions[role] ?? new Set<BusinessPermission>())];
}

// ---------------------------------------------------------------------------------------------
// Staff role hierarchy (docs/architecture/staff-invitations.md)
// ---------------------------------------------------------------------------------------------

/**
 * Authority rank for staff management. You may grant, change or remove only roles strictly below
 * your own: the owner manages managers and staff; a manager manages staff but never another
 * manager or the owner. Every non-management role shares the lowest rank.
 */
const staffRank: Record<BusinessRole, number> = {
  owner: 3,
  manager: 2,
  sales_agent: 1,
  cashier: 1,
  driver: 1,
  view_only: 1
};

/** Roles an invitation may carry. `owner` is never grantable: a business has exactly one. */
export const invitableRoles: readonly BusinessRole[] = [
  "manager",
  "sales_agent",
  "cashier",
  "driver",
  "view_only"
];

/** The roles `actorRole` may invite someone into or change someone to. Empty if none. */
export function rolesGrantableBy(actorRole: BusinessRole): BusinessRole[] {
  if (!roleCan(actorRole, "membership:invite")) return [];
  return invitableRoles.filter((role) => staffRank[role] < staffRank[actorRole]);
}

/** Whether `actorRole` may change or remove a member currently holding `targetRole`. */
export function canManageMemberRole(actorRole: BusinessRole, targetRole: BusinessRole): boolean {
  return roleCan(actorRole, "membership:invite") && staffRank[targetRole] < staffRank[actorRole];
}
