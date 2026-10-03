import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type {
  CountryTaxConfigSummary,
  TaxCountryCode,
  VerificationTier,
  VerificationTierSummary
} from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import { roundMoney, isValidTaxRate } from "../shared/money.js";
import { normalizeOptionalText, nullableText } from "../shared/text-normalization.js";

export interface VerificationTierInput {
  tier: VerificationTier;
  evidenceType?: "none" | "owner_attestation" | "business_document" | null;
  note?: string | null;
}

export interface CountryTaxConfigInput {
  countryCode: TaxCountryCode;
  defaultTaxRate: number;
  taxId?: string | null;
  pricesIncludeTax?: boolean;
}

export interface NormalizedVerificationTierInput {
  tier: VerificationTier;
  evidenceType: "none" | "owner_attestation" | "business_document";
  note: string | null;
}

export interface NormalizedCountryTaxConfigInput {
  countryCode: TaxCountryCode;
  defaultTaxRate: number;
  taxId: string | null;
  pricesIncludeTax: boolean;
}

export function validateVerificationTierInput(input: VerificationTierInput): ValidationResult {
  const errors: string[] = [];

  if (!isVerificationTier(input.tier)) {
    errors.push("Verification tier is not supported.");
  }

  if (
    input.evidenceType !== undefined &&
    input.evidenceType !== null &&
    input.evidenceType !== "none" &&
    input.evidenceType !== "owner_attestation" &&
    input.evidenceType !== "business_document"
  ) {
    errors.push("Verification evidence type is not supported.");
  }

  if (normalizeOptionalText(input.note).length > 240) {
    errors.push("Verification note must be 240 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateCountryTaxConfigInput(input: CountryTaxConfigInput): ValidationResult {
  const errors: string[] = [];

  if (!isTaxCountryCode(input.countryCode)) {
    errors.push("Tax country code is not supported.");
  }

  if (!isValidTaxRate(input.defaultTaxRate)) {
    errors.push("Default tax rate must be between 0 and 1.");
  }

  if (normalizeOptionalText(input.taxId).length > 64) {
    errors.push("Tax id must be 64 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function normalizeVerificationTierInput(
  input: VerificationTierInput
): NormalizedVerificationTierInput {
  return {
    tier: input.tier,
    evidenceType:
      input.evidenceType ?? (input.tier === "unverified" ? "none" : "owner_attestation"),
    note: nullableText(input.note)
  };
}

export function normalizeCountryTaxConfigInput(
  input: CountryTaxConfigInput
): NormalizedCountryTaxConfigInput {
  return {
    countryCode: input.countryCode,
    defaultTaxRate: roundMoney(input.defaultTaxRate),
    taxId: nullableText(input.taxId),
    pricesIncludeTax: input.pricesIncludeTax ?? false
  };
}

export function isVerificationTier(value: string): value is VerificationTier {
  return value === "unverified" || value === "owner_verified" || value === "business_verified";
}

export function isTaxCountryCode(value: string): value is TaxCountryCode {
  return value === "KE";
}

export function verificationTierUpdatedEvent(input: {
  id: string;
  verification: VerificationTierSummary;
  previousTier: VerificationTier;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  previousTier: VerificationTier;
  tier: VerificationTier;
  evidenceType: VerificationTierSummary["evidenceType"];
}> {
  return createEvent({
    id: input.id,
    type: "compliance.verification_tier_updated",
    aggregateId: input.verification.businessId,
    aggregateType: "verification_tier",
    actorId: input.actorId,
    risk: "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.verification.businessId,
      previousTier: input.previousTier,
      tier: input.verification.tier,
      evidenceType: input.verification.evidenceType
    }
  });
}

export function taxConfigUpdatedEvent(input: {
  id: string;
  taxConfig: CountryTaxConfigSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  businessId: string;
  countryCode: TaxCountryCode;
  defaultTaxRate: number;
  pricesIncludeTax: boolean;
}> {
  return createEvent({
    id: input.id,
    type: "compliance.tax_config_updated",
    aggregateId: input.taxConfig.businessId,
    aggregateType: "tax_config",
    actorId: input.actorId,
    risk: "high",
    occurredAt: input.occurredAt,
    payload: {
      businessId: input.taxConfig.businessId,
      countryCode: input.taxConfig.countryCode,
      defaultTaxRate: input.taxConfig.defaultTaxRate,
      pricesIncludeTax: input.taxConfig.pricesIncludeTax
    }
  });
}
