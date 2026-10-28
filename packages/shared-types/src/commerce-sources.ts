export const commerceSourceTypes = [
  "DEVICE_GALLERY",
  "PURCHASE_RECEIPT",
  "SUPPLIER_CATALOGUE",
  "SALES_AGENT",
  "DOCUMENT_IMPORT",
  "CONVERSATION",
  "WEBSITE",
  "ERP"
] as const;
export type CommerceSourceType = (typeof commerceSourceTypes)[number];
interface CommerceRecordBase {
  id: string;
  businessId: string;
  createdAt: string;
  updatedAt: string;
}
export interface CommerceSource extends CommerceRecordBase {
  kind: "source";
  type: CommerceSourceType;
  reference: string;
  label: string;
  status: "connected" | "disconnected";
  authority: "owner_maintained" | "agent_maintained";
  syncPolicy: "manual" | "on_demand";
  authorization?: { method: "website_challenge"; verifiedAt: string; origin: string };
  challenge?: string;
  refreshAttemptAt?: string;
  refreshToken?: string;
  representationId?: string | null;
  distributionRelationshipId?: string;
  lastSuccessfulRefresh: string | null;
  error: string | null;
}
export interface ProductSourceBinding extends CommerceRecordBase {
  kind: "binding";
  sourceId: string;
  productId: string;
  externalProductId: string;
  confirmedBy: string;
  identity?: CommerceProductIdentity;
}
export interface CommerceOffer extends CommerceRecordBase {
  kind: "offer";
  productId: string;
  sourceId: string | null;
  upstreamOfferId: string | null;
  price: number;
  currency: string;
  priceUpdatedAt: string;
  validUntil: string;
  status: "draft" | "published" | "withdrawn";
  availability: "unknown" | "available" | "unavailable";
  availabilityEvidence: string | null;
  fulfillment: "seller" | "upstream";
  allowResell: boolean;
  productUrl?: string;
  availabilityUpdatedAt?: string;
}
export interface DistributionRelationship extends CommerceRecordBase {
  kind: "relationship";
  targetBusinessId: string;
  status: "requested" | "accepted" | "rejected" | "revoked";
  respondedBy: string | null;
}
export type UnifiedCommerceRecord =
  | CommerceSource
  | ProductSourceBinding
  | CommerceOffer
  | DistributionRelationship
  | CommerceSourceCandidate
  | CommerceRepresentation;
export interface PublishedCommerceOffer {
  id: string;
  businessId: string;
  seller: string;
  productId: string;
  name: string;
  unit: string;
  aliases: string[];
  price: number;
  currency: string;
  availability: CommerceOffer["availability"];
  priceUpdatedAt: string;
  validUntil: string;
  upstreamOfferId: string | null;
  fulfillment: CommerceOffer["fulfillment"];
}

export interface CommerceProductIdentity {
  sku?: string;
  skuNamespace?: string;
  barcode?: string;
  brand?: string;
  packaging?: string;
  variant?: string;
  unit?: string;
}
export interface CommerceFeedProduct {
  externalId: string;
  name: string;
  unit: string;
  identity?: CommerceProductIdentity;
  price: number | null;
  currency: string;
  validUntil: string;
  availability?: CommerceOffer["availability"];
  evidence?: string;
  productUrl?: string;
}
export interface CommerceSourceCandidate extends CommerceRecordBase {
  kind: "candidate";
  sourceId: string;
  externalProductId: string;
  fingerprint: string;
  status: "review" | "confirmed" | "rejected";
  product: CommerceFeedProduct;
  conflict: string | null;
  confirmedProductId: string | null;
  offerId: string | null;
}
export interface CommerceRepresentation extends CommerceRecordBase {
  kind: "representation";
  principalBusinessId: string;
  status: "requested" | "authorized" | "rejected" | "revoked";
  territory: string | null;
  decidedBy: string | null;
}
export interface CommerceOfferOrderSnapshot {
  offerId: string;
  sellerBusinessId: string;
  productBusinessId: string;
  productId: string;
  sourceId: string | null;
  price: number;
  currency: string;
  priceUpdatedAt: string;
  validUntil: string;
  availability: CommerceOffer["availability"];
  fulfillment: CommerceOffer["fulfillment"];
  chain: {
    offerId: string;
    businessId: string;
    sourceId: string | null;
    representationId: string | null;
  }[];
}
