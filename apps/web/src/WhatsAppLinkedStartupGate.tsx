import { lazy, Suspense } from "react";
import { isNativeDeviceHost } from "./device-messaging";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { loadLazyModuleWithRecovery } from "./lazy-module-recovery";

const moduleKey = "whatsapp-linked-startup";
const WhatsAppLinkedConnection = lazy(() =>
  loadLazyModuleWithRecovery(moduleKey, () => import("./WhatsAppLinkedConnection"))
);

/**
 * The startup WhatsApp linking prompt: only in the Android app, and only for the owner of the
 * active shop. Kept out of GrogoniApplication so the shell stays inside its line budget.
 */
export function WhatsAppLinkedStartupGate({
  accountId,
  businessId,
  shops
}: {
  accountId: string | undefined;
  businessId: string | undefined;
  shops: ReadonlyArray<{ business: { id: string }; membership: { role: string } }> | undefined;
}) {
  const isOwner =
    shops?.some((shop) => shop.business.id === businessId && shop.membership.role === "owner") ??
    false;
  if (!isNativeDeviceHost() || businessId === undefined || !isOwner) return null;
  return (
    <LazyModuleErrorBoundary label="WhatsApp linking" moduleKey={moduleKey}>
      <Suspense fallback={null}>
        <WhatsAppLinkedConnection
          key={`${accountId}:${businessId}`}
          businessId={businessId}
          startup
        />
      </Suspense>
    </LazyModuleErrorBoundary>
  );
}

