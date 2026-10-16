export interface PurchaseOrderSnapshot {
  id: string;
  businessId: string;
  supplierId: string;
  currency: string;
  totalMinor: number;
  items: { productId: string; quantityMilli: number; totalMinor: number; unit: string }[];
}
export type PurchaseOrderStatus =
  | "SUBMITTED_IN_APP"
  | "DISPATCHING"
  | "PROVIDER_ACCEPTED"
  | "DELIVERY_UNKNOWN"
  | "ACCEPTED"
  | "REJECTED";
export interface PurchaseOrderView {
  order_id: string;
  business_id: string;
  draft_id?: string;
  channel: "grogoni" | "email" | "whatsapp";
  recipient?: string;
  status: PurchaseOrderStatus;
  revision: number;
  snapshot: PurchaseOrderSnapshot;
}
export interface PurchaseOrderReview {
  recipients: { supplierId: string; businessId: string; name: string }[];
  drafts: (PurchaseOrderSnapshot & { digest: string })[];
  incoming: PurchaseOrderView[];
  outgoing: PurchaseOrderView[];
  whatsappAvailable: boolean;
  emailMailboxIds: string[];
}
