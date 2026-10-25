/**
 * The business's public-share identity: the per-channel links a shop hands out so customers can
 * reach it (docs/architecture/business-share-links.md).
 *
 * Every field here is data the owner enters. Nothing is defaulted from code: `allowCustomerOrders`
 * is nullable, and `null` means "the owner has not decided" - never `false`, which is a real
 * decision to stop taking orders from this channel. Keeping the distinction lets the web app show
 * "not set yet" instead of silently implying a choice the owner never made (mirrors the A11
 * timezone rule in corridor-fulfillment: business facts are set by the owner, never by the code).
 */
export interface BusinessShareLinksSummary {
  businessId: string;
  /** The channel-neutral storefront link that resolves today (`/s/<grogoniId>`). */
  storefrontUrl: string;
  /** The friendlier public-facing "handle@grogoni.com" address (see commerce-address.ts). */
  commerceAddress: string;
  /** A shareable click-to-chat link for this business, or null when not configured. */
  whatsappUrl: string | null;
  /** A free-form public note ("Open Mon-Sat 8am-6pm"), or null. */
  publicNote: string | null;
  /**
   * Whether orders arriving from a customer are accepted on this shop's links. `null` = not yet
   * set by the owner.
   */
  allowCustomerOrders: boolean | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** The editable subset of `BusinessShareLinksSummary` a PATCH accepts. */
export interface BusinessShareLinksPatch {
  whatsappUrl?: string | null;
  publicNote?: string | null;
  allowCustomerOrders?: boolean | null;
}

/** The maximum lengths the store enforces, so the web app can pre-validate the same way. */
export const businessShareLinksLimits = {
  whatsappUrlMaximumLength: 512,
  publicNoteMaximumLength: 280
} as const;
