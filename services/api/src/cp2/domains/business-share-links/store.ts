/**
 * Business share-links domain. Owns the per-business public-share identity: the click-to-chat
 * WhatsApp link, a free-form public note, and whether customer orders are accepted from public
 * links (packages/shared-types/src/business-settings.ts). Kept business-scoped: every method gates
 * on `requireAuthorizedSession`, mirroring the other business-scoped domains.
 *
 * Owner-entered facts only: `allowCustomerOrders` is nullable and `null` means "not yet decided" -
 * never coerced to `false`, which is a real decision to stop taking orders (see the interface doc).
 * The storefront and commerce addresses are derived at read time from `getStoreLinks` /
 * `commerceAddressFromGrogoniId` so they never drift from the canonical grogoniId.
 */
import type {
  AuthenticatedActorView,
  BusinessShareLinksPatch,
  BusinessShareLinksSummary,
  BusinessSummary
} from "@grogoni/shared-types";
import {
  getStoreLinks,
  commerceAddressFromGrogoniId,
  parseWhatsAppShareLink
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { normalizeOptionalBoundedText } from "../../text-normalization.js";

const whatsappUrlMaximumLength = 512;
const publicNoteMaximumLength = 280;

interface StoredShareLinks {
  businessId: string;
  whatsappUrl: string | null;
  publicNote: string | null;
  allowCustomerOrders: boolean | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface BusinessShareLinksDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: "business:read" | "business:create",
    now: Date
  ) => AuthenticatedActorView;
  businesses: Map<string, BusinessSummary>;
}

export class BusinessShareLinksDomain {
  private readonly shareLinks = new Map<string, StoredShareLinks>();

  constructor(private readonly deps: BusinessShareLinksDomainDeps) {}

  clear(): void {
    this.shareLinks.clear();
  }

  getShareLinks(input: {
    sessionId: string | null;
    businessId: string;
    webOrigin: string;
    now?: Date;
  }): BusinessShareLinksSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "business:read", now);
    return this.summaryFor(input.businessId, input.webOrigin);
  }

  updateShareLinks(input: {
    sessionId: string | null;
    businessId: string;
    webOrigin: string;
    patch: BusinessShareLinksPatch;
    now?: Date;
  }): BusinessShareLinksSummary {
    const now = input.now ?? new Date();
    const actor = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:create",
      now
    );
    const business = this.deps.businesses.get(input.businessId);
    if (business === undefined) {
      throw new Cp2Error(404, "business_not_found", "Business was not found.");
    }

    const current = this.shareLinks.get(input.businessId) ?? emptyStored(input.businessId);
    const next: StoredShareLinks = { ...current };

    if ("publicNote" in input.patch) {
      next.publicNote = normalizeOptionalBoundedText(
        input.patch.publicNote ?? null,
        publicNoteMaximumLength
      );
    }
    if ("allowCustomerOrders" in input.patch) {
      next.allowCustomerOrders = normalizeAllowCustomerOrders(input.patch.allowCustomerOrders);
    }
    if ("whatsappUrl" in input.patch) {
      next.whatsappUrl = normalizeWhatsAppUrl(input.patch.whatsappUrl ?? null);
    }

    next.updatedBy = actor.user.id;
    next.updatedAt = now.toISOString();
    this.shareLinks.set(input.businessId, next);
    return this.summaryFor(input.businessId, input.webOrigin);
  }

  private summaryFor(businessId: string, webOrigin: string): BusinessShareLinksSummary {
    const business = this.deps.businesses.get(businessId);
    if (business === undefined) {
      throw new Cp2Error(404, "business_not_found", "Business was not found.");
    }
    const stored = this.shareLinks.get(businessId) ?? emptyStored(businessId);
    const links = getStoreLinks(business.grogoniId, {
      webOrigin,
      telegramBotUsername: ""
    });
    return {
      businessId,
      storefrontUrl: links.universal,
      commerceAddress: commerceAddressFromGrogoniId(business.grogoniId),
      whatsappUrl: stored.whatsappUrl,
      publicNote: stored.publicNote,
      allowCustomerOrders: stored.allowCustomerOrders,
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt
    };
  }
}

function emptyStored(businessId: string): StoredShareLinks {
  return {
    businessId,
    whatsappUrl: null,
    publicNote: null,
    allowCustomerOrders: null,
    updatedBy: null,
    updatedAt: null
  };
}

function normalizeAllowCustomerOrders(value: boolean | null | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new Cp2Error(400, "allow_customer_orders_invalid", "Choose whether to accept orders.");
  }
  return value;
}

function normalizeWhatsAppUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > whatsappUrlMaximumLength) {
    throw new Cp2Error(
      400,
      "value_too_long",
      `Value must be ${whatsappUrlMaximumLength} characters or fewer.`
    );
  }
  const parsed = parseWhatsAppShareLink(trimmed);
  if (parsed === null) {
    throw new Cp2Error(
      400,
      "whatsapp_url_invalid",
      "Enter a WhatsApp click-to-chat link (https://wa.me/...) or a phone number."
    );
  }
  return parsed.url;
}
