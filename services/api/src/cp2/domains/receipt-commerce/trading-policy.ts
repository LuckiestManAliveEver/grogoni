import type {
  CommerceTransactionKind,
  CommerceRepresentation,
  GrantDecision,
  ProjectionEffect,
  TradingGrant
} from "@grogoni/shared-types";

/** Require an unambiguous, real UTC expiry; Date.parse alone normalizes impossible dates. */
export function normalizeTradingExpiry(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  const canonical = new Date(value).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z") ? canonical : null;
}

/** Re-evaluated on every attempt. A saved/contact match is never a grant. */
export function evaluateTradingGrant(input: {
  grant: TradingGrant | null;
  businessId: string;
  partnerBusinessId: string;
  kind: CommerceTransactionKind;
  amountMinor: number;
  currency: string;
  effects: ProjectionEffect[];
  now: Date;
  agent?: boolean;
  representation?: CommerceRepresentation | null;
}): GrantDecision {
  const grant = input.grant;
  const deny = (reason: GrantDecision["reason"]): GrantDecision => ({
    authorized: false,
    reason,
    grantId: grant?.id ?? null,
    permittedEffects: []
  });
  if (!Number.isFinite(input.now.getTime())) return deny("grant_expired");
  if (
    !grant ||
    grant.businessId !== input.businessId ||
    grant.partnerBusinessId !== input.partnerBusinessId
  )
    return deny("no_grant");
  if (grant.status !== "active" || grant.revokedAt !== null) return deny("grant_revoked");
  if (
    grant.expiresAt !== null &&
    (normalizeTradingExpiry(grant.expiresAt) === null ||
      Date.parse(grant.expiresAt) <= input.now.getTime())
  )
    return deny("grant_expired");
  if (!grant.allowedKinds.includes(input.kind)) return deny("kind_not_allowed");
  if (grant.currency !== input.currency) return deny("currency_mismatch");
  if (
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor < 0 ||
    grant.maxTransactionMinor === null ||
    !Number.isSafeInteger(grant.maxTransactionMinor) ||
    input.amountMinor > grant.maxTransactionMinor
  )
    return deny("amount_over_limit");
  if (
    input.agent &&
    (!grant.agentDelegation.enabled ||
      grant.agentDelegation.maxTransactionMinor === null ||
      !Number.isSafeInteger(grant.agentDelegation.maxTransactionMinor) ||
      input.amountMinor > grant.agentDelegation.maxTransactionMinor)
  )
    return deny("permission_missing");
  if (grant.partnerRole === "salesperson") {
    const representation = input.representation;
    if (
      !representation ||
      representation.id !== grant.representationId ||
      representation.status !== "authorized" ||
      representation.businessId !== grant.partnerBusinessId ||
      representation.principalBusinessId !== grant.businessId
    )
      return deny("representation_not_authorized");
  }
  const permitted = (effect: ProjectionEffect): boolean => {
    switch (effect) {
      case "stock_in":
      case "stock_out":
        return grant.permissions.postInventory === true;
      case "purchase_record":
      case "sale_record":
      case "payable":
      case "receivable":
        return grant.permissions.recordBalance === true;
      case "payment_record":
        return grant.permissions.recordPayment === true;
      case "sales_attribution":
      case "commission_eligibility":
        return grant.permissions.attributeSales === true;
      case "partner_link":
        return grant.localPartnerRef !== null || grant.partnerRole === "salesperson";
    }
  };
  if (!input.effects.every(permitted)) return deny("permission_missing");
  return {
    authorized: true,
    reason: "authorized",
    grantId: grant.id,
    permittedEffects: [...new Set(input.effects)]
  };
}
