import { lazy, Suspense, type ReactNode } from "react";

import type { ConversationMessageContent } from "@grogoni/shared-types";
import { loadLazyModuleWithRecovery, ownerModuleKeys } from "./lazy-module-recovery";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";

const InventoryTaskCard = lazy(() =>
  loadLazyModuleWithRecovery(ownerModuleKeys.inventoryTaskCard, () => import("./InventoryTaskCard"))
);

import {
  CustomerManagementCard,
  FulfilmentSplitCard,
  ImportManagementCard,
  InvoiceManagementCard,
  LogisticsManagementCard,
  PaymentManagementCard,
  ProductCaptureItemsCard,
  ProductManagementCard,
  StatusBroadcastCard,
  SupplierManagementCard
} from "./grogoni-application-shared";

/**
 * The generated-surface registry: one renderer per ConversationMessageContent variant, looked up
 * by content.type instead of the caller checking one more optional field per new card type. See
 * docs/frontend/frontend.md ("The generated-surface protocol"). Adding a new capability's
 * generated card is: add the variant to ConversationMessageContent, add one entry here - it does
 * not require touching ChatSurface.tsx's render body again.
 *
 * An unrecognized content.type (a future server addition this client hasn't shipped a renderer
 * for yet) has no entry and renderGeneratedSurface returns null - the message still renders its
 * body text, degrading safely instead of crashing the thread.
 */
export interface GeneratedSurfaceContext {
  businessId: string | null;
  onStatusBroadcastPosted: (statusBroadcastId: string) => void;
}

type GeneratedSurfaceRenderer = (
  content: ConversationMessageContent,
  context: GeneratedSurfaceContext
) => ReactNode | null;

const generatedSurfaceRegistry: Partial<
  Record<ConversationMessageContent["type"], GeneratedSurfaceRenderer>
> = {
  text: (content, context) => {
    if (
      content.type !== "text" ||
      !content.businessTask ||
      content.businessTask.businessId !== context.businessId
    )
      return null;
    return (
      <LazyModuleErrorBoundary moduleKey={ownerModuleKeys.inventoryTaskCard} label="Inventory task">
        <Suspense fallback={<div role="status">Loading inventory task...</div>}>
          <InventoryTaskCard
            key={content.businessTask.taskId}
            businessId={content.businessTask.businessId}
            taskId={content.businessTask.taskId}
          />
        </Suspense>
      </LazyModuleErrorBoundary>
    );
  },
  "product-capture-progress": (content, context) => {
    if (content.type !== "product-capture-progress" || context.businessId === null) return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening photo review…</div>}>
        <ProductCaptureItemsCard
          businessId={context.businessId}
          captureJobId={content.captureJobId}
          onPosted={context.onStatusBroadcastPosted}
        />
      </Suspense>
    );
  },
  "status-broadcast": (content, context) => {
    if (content.type !== "status-broadcast" || context.businessId === null) return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening status…</div>}>
        <StatusBroadcastCard
          businessId={context.businessId}
          statusBroadcastId={content.statusBroadcastId}
        />
      </Suspense>
    );
  },
  "unified-checkout": (content) => {
    if (content.type !== "unified-checkout") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening order…</div>}>
        <FulfilmentSplitCard unifiedCheckoutId={content.unifiedCheckoutId} />
      </Suspense>
    );
  },
  "product-management": (content) => {
    if (content.type !== "product-management") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening products…</div>}>
        <ProductManagementCard
          businessId={content.businessId}
          {...(content.productId === undefined ? {} : { productId: content.productId })}
        />
      </Suspense>
    );
  },
  "supplier-management": (content) => {
    if (content.type !== "supplier-management") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening suppliers…</div>}>
        <SupplierManagementCard
          businessId={content.businessId}
          {...(content.supplierId === undefined ? {} : { supplierId: content.supplierId })}
        />
      </Suspense>
    );
  },
  "customer-management": (content) => {
    if (content.type !== "customer-management") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening customers…</div>}>
        <CustomerManagementCard
          businessId={content.businessId}
          {...(content.customerId === undefined ? {} : { customerId: content.customerId })}
        />
      </Suspense>
    );
  },
  "invoice-management": (content) => {
    if (content.type !== "invoice-management") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening invoices…</div>}>
        <InvoiceManagementCard
          businessId={content.businessId}
          {...(content.customerName === undefined ? {} : { customerName: content.customerName })}
        />
      </Suspense>
    );
  },
  "payment-management": (content) => {
    if (content.type !== "payment-management") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening payments…</div>}>
        <PaymentManagementCard
          businessId={content.businessId}
          {...(content.customerName === undefined ? {} : { customerName: content.customerName })}
        />
      </Suspense>
    );
  },
  "import-management": (content) => {
    if (content.type !== "import-management") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening imports…</div>}>
        <ImportManagementCard
          businessId={content.businessId}
          {...(content.importJobId === undefined ? {} : { importJobId: content.importJobId })}
        />
      </Suspense>
    );
  },
  "logistics-management": (content) => {
    if (content.type !== "logistics-management") return null;
    return (
      <Suspense fallback={<div className="inline-loading-card">Opening deliveries…</div>}>
        <LogisticsManagementCard
          businessId={content.businessId}
          {...(content.customerName === undefined ? {} : { customerName: content.customerName })}
        />
      </Suspense>
    );
  }
};

export function renderGeneratedSurface(
  content: ConversationMessageContent | undefined,
  context: GeneratedSurfaceContext
): ReactNode | null {
  if (content === undefined) return null;
  const renderer = generatedSurfaceRegistry[content.type];
  return renderer === undefined ? null : renderer(content, context);
}
