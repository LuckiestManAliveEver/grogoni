import * as Screens from "./owner-workspace-screens";
import type { ReactNode } from "react";
import {
  emptyCustomerForm,
  emptyInvoiceForm,
  emptyProductForm,
  emptySupplierForm
} from "./grogoni-application-shared";
import type { ShellView } from "./app-shell";
import { ProductSurface } from "./ProductSurface";
import { CustomerSurface } from "./CustomerSurface";
import { InvoiceSurface } from "./InvoiceSurface";
import { NetworkSurface } from "./NetworkSurface";
import { SyncSurface } from "./SyncSurface";
import { RuntimeSurface } from "./RuntimeSurface";
import { PaymentSurface } from "./PaymentSurface";
import { ReportsSurface } from "./ReportsSurface";
import { NotificationsSurface } from "./NotificationsSurface";

import type { useAsyncActions } from "./hooks/useAsyncActions";
import type { useProductsState } from "./hooks/useProductsState";
import type { useSuppliersState } from "./hooks/useSuppliersState";
import type { useCustomersState } from "./hooks/useCustomersState";
import type { useInvoicesState } from "./hooks/useInvoicesState";
import type { useNetworkState } from "./hooks/useNetworkState";
import type { useSyncState } from "./hooks/useSyncState";
import type { useRuntimeHistoryState } from "./hooks/useRuntimeHistoryState";
import type { usePaymentsState } from "./hooks/usePaymentsState";
import type { useImportsState } from "./hooks/useImportsState";
import type { useLogisticsState } from "./hooks/useLogisticsState";
import type { useReadinessState } from "./hooks/useReadinessState";
import type { useReportsState } from "./hooks/useReportsState";
import type { useNotificationsState } from "./hooks/useNotificationsState";
import type { useStorefrontCareState } from "./hooks/useStorefrontCareState";
import type { useNavigationState } from "./hooks/useNavigationState";
import type { useAuthState } from "./hooks/useAuthState";
import type { useChatThreadState } from "./hooks/useChatThreadState";

type AsyncState = Pick<ReturnType<typeof useAsyncActions>, "runAction">;
type ProductState = Pick<
  ReturnType<typeof useProductsState>,
  | "products"
  | "productForm"
  | "stockProductId"
  | "stockQuantityAfter"
  | "stockReason"
  | "setProductForm"
  | "setStockProductId"
  | "setStockQuantityAfter"
  | "setStockReason"
  | "loadProducts"
  | "saveProduct"
  | "deleteProduct"
  | "adjustStock"
>;
type SupplierState = Pick<
  ReturnType<typeof useSuppliersState>,
  | "suppliers"
  | "purchaseReceipts"
  | "receiptOcrJobs"
  | "supplierForm"
  | "setSupplierForm"
  | "saveSupplier"
  | "deleteSupplierCard"
  | "saveSalesAgent"
  | "deleteSalesAgentCard"
  | "searchSupplierContacts"
  | "linkSupplierPhoneContact"
  | "createSupplierFromPhoneContact"
  | "linkSalesAgentPhoneContact"
  | "createSalesAgentFromPhoneContact"
  | "uploadSupplierReceipt"
  | "confirmSupplierReceipt"
>;
type CustomerState = Pick<
  ReturnType<typeof useCustomersState>,
  "customers" | "customerForm" | "setCustomerForm" | "saveCustomer" | "loadCustomers"
>;
type InvoiceState = Pick<
  ReturnType<typeof useInvoicesState>,
  | "invoices"
  | "invoiceForm"
  | "invoicePreview"
  | "setInvoiceForm"
  | "setInvoicePreview"
  | "previewInvoice"
  | "saveInvoice"
  | "confirmInvoice"
  | "printInvoice"
  | "loadInvoices"
>;
type NetworkState = Pick<
  ReturnType<typeof useNetworkState>,
  | "networkGraph"
  | "networkInvites"
  | "loadNetworkGraph"
  | "loadNetworkInvites"
  | "syncPhoneNetwork"
  | "syncSocialNetwork"
  | "requestNetworkRoute"
  | "approveNetworkRoute"
  | "rejectNetworkRoute"
  | "disconnectNetworkSource"
  | "shareOwnerStorefrontInvite"
  | "syncOwnerPhoneContacts"
  | "importContactsFile"
  | "exportOwnerContacts"
>;
type SyncState = Pick<
  ReturnType<typeof useSyncState>,
  | "syncSummary"
  | "syncQueue"
  | "offlineCache"
  | "loadSyncQueue"
  | "loadOfflineCache"
  | "replaySyncQueue"
  | "replaySyncQueueItem"
>;
type RuntimeHistoryState = Pick<
  ReturnType<typeof useRuntimeHistoryState>,
  | "runtimeSessions"
  | "selectedRuntimeHistorySessionId"
  | "setSelectedRuntimeHistorySessionId"
  | "runtimeTurns"
  | "loadRuntimeSessions"
  | "loadRuntimeTurns"
  | "createRuntimeHistorySession"
>;
type PaymentState = Pick<
  ReturnType<typeof usePaymentsState>,
  | "payments"
  | "invoicePayments"
  | "customerDebts"
  | "paymentForm"
  | "setPaymentForm"
  | "loadPaymentData"
  | "recordPayment"
>;
type ImportState = Pick<
  ReturnType<typeof useImportsState>,
  | "importForm"
  | "importJobs"
  | "activeImportJob"
  | "selectedImportJobId"
  | "setImportForm"
  | "setSelectedImportJobId"
  | "createDocumentImport"
  | "updateImportRowLocal"
  | "saveImportRow"
  | "confirmImport"
  | "loadDocumentImports"
>;
type LogisticsState = Pick<
  ReturnType<typeof useLogisticsState>,
  | "logistics"
  | "logisticsForm"
  | "setLogisticsForm"
  | "loadLogistics"
  | "createLogistics"
  | "updateLogisticsStatus"
>;
type ReadinessState = Pick<
  ReturnType<typeof useReadinessState>,
  | "securityReview"
  | "dataExport"
  | "verificationTier"
  | "taxConfig"
  | "deviceTrust"
  | "complianceForm"
  | "setComplianceForm"
  | "loadCompliance"
  | "createDataExport"
  | "saveVerificationTier"
  | "saveTaxConfig"
  | "saveDeviceTrust"
  | "betaReadiness"
  | "betaSupportTickets"
  | "betaForm"
  | "setBetaForm"
  | "loadBetaReadiness"
  | "updateBetaAccess"
  | "enableBetaFlags"
  | "recordBetaDeviceTest"
  | "createBetaSupportTicket"
  | "updateBetaSupportTicketStatus"
  | "recordBetaTelemetry"
  | "launchReadiness"
  | "launchIncidents"
  | "launchForm"
  | "setLaunchForm"
  | "loadLaunchReadiness"
  | "updateLaunchSettings"
  | "updateLaunchChecklist"
  | "createLaunchIncident"
  | "updateLaunchIncidentStatus"
>;
type ReportsState = Pick<
  ReturnType<typeof useReportsState>,
  "reportSummary" | "knowledgeSummary" | "loadReports"
>;
type NotificationState = Pick<
  ReturnType<typeof useNotificationsState>,
  "notificationInbox" | "loadNotifications" | "updateNotification"
>;
type StorefrontCareState = Pick<
  ReturnType<typeof useStorefrontCareState>,
  "storefrontCareRequests" | "storefrontMessages" | "storefrontOrders" | "loadStorefrontInbox"
>;
type NavigationState = Pick<
  ReturnType<typeof useNavigationState>,
  "navigateToView" | "setRoutedProductId" | "openProduct"
>;
type AuthState = Pick<
  ReturnType<typeof useAuthState>,
  "authenticateSocialProfile" | "oauthProviders"
>;
type ChatThreadState = Pick<
  ReturnType<typeof useChatThreadState>,
  "setChatMessages" | "setRuntimeSessionId"
>;

export interface OwnerWorkspaceBindings {
  networkOnboarding?: ReactNode;
  businessId: string | null;
  /**
   * The viewer's permissions in the open business (display only: which cards to show; the server
   * authorizes everything). Empty when unknown, including while the session context still
   * describes another shop or marketplace mode (see active-shop-permissions.ts).
   */
  businessPermissions: readonly string[];
  view: ShellView;
  publicStorefrontUrl: string;
  asyncActions: AsyncState;
  productsState: ProductState;
  suppliersState: SupplierState;
  customersState: CustomerState;
  invoicesState: InvoiceState;
  networkState: NetworkState;
  syncState: SyncState;
  runtimeHistoryState: RuntimeHistoryState;
  paymentsState: PaymentState;
  importsState: ImportState;
  logisticsState: LogisticsState;
  readinessState: ReadinessState;
  reportsState: ReportsState;
  notificationState: NotificationState;
  storefrontCareState: StorefrontCareState;
  navigationState: NavigationState;
  authState: AuthState;
  chatThreadState: ChatThreadState;
}

export function renderOwnerWorkspace(input: OwnerWorkspaceBindings) {
  const screen = renderOwnerWorkspaceScreen(input);
  if (screen === null) return null;
  return (
    <Screens.WorkspaceScreenBoundary view={input.view}>{screen}</Screens.WorkspaceScreenBoundary>
  );
}

function renderOwnerWorkspaceScreen(input: OwnerWorkspaceBindings) {
  const { businessId, publicStorefrontUrl, view } = input;
  if (view === "network") return renderNetworkWorkspace(input);
  if (businessId === null) return null;
  const { runAction } = input.asyncActions;
  const {
    products,
    productForm,
    stockProductId,
    stockQuantityAfter,
    stockReason,
    setProductForm,
    setStockProductId,
    setStockQuantityAfter,
    setStockReason,
    loadProducts,
    saveProduct,
    deleteProduct,
    adjustStock
  } = input.productsState;
  const {
    suppliers,
    purchaseReceipts,
    receiptOcrJobs,
    supplierForm,
    setSupplierForm,
    saveSupplier,
    deleteSupplierCard,
    saveSalesAgent,
    deleteSalesAgentCard,
    searchSupplierContacts,
    linkSupplierPhoneContact,
    createSupplierFromPhoneContact,
    linkSalesAgentPhoneContact,
    createSalesAgentFromPhoneContact,
    uploadSupplierReceipt,
    confirmSupplierReceipt
  } = input.suppliersState;
  const { customers, customerForm, setCustomerForm, saveCustomer, loadCustomers } =
    input.customersState;
  const {
    invoices,
    invoiceForm,
    invoicePreview,
    setInvoiceForm,
    setInvoicePreview,
    previewInvoice,
    saveInvoice,
    confirmInvoice,
    printInvoice,
    loadInvoices
  } = input.invoicesState;
  const {
    shareOwnerStorefrontInvite,
    syncOwnerPhoneContacts,
    importContactsFile,
    exportOwnerContacts
  } = input.networkState;
  const {
    syncSummary,
    syncQueue,
    offlineCache,
    loadSyncQueue,
    loadOfflineCache,
    replaySyncQueue,
    replaySyncQueueItem
  } = input.syncState;
  const {
    runtimeSessions,
    selectedRuntimeHistorySessionId,
    setSelectedRuntimeHistorySessionId,
    runtimeTurns,
    loadRuntimeSessions,
    loadRuntimeTurns,
    createRuntimeHistorySession
  } = input.runtimeHistoryState;
  const {
    payments,
    invoicePayments,
    customerDebts,
    paymentForm,
    setPaymentForm,
    loadPaymentData,
    recordPayment
  } = input.paymentsState;
  const {
    importForm,
    importJobs,
    activeImportJob,
    selectedImportJobId,
    setImportForm,
    setSelectedImportJobId,
    createDocumentImport,
    updateImportRowLocal,
    saveImportRow,
    confirmImport,
    loadDocumentImports
  } = input.importsState;
  const {
    logistics,
    logisticsForm,
    setLogisticsForm,
    loadLogistics,
    createLogistics,
    updateLogisticsStatus
  } = input.logisticsState;
  const {
    securityReview,
    dataExport,
    verificationTier,
    taxConfig,
    deviceTrust,
    complianceForm,
    setComplianceForm,
    loadCompliance,
    createDataExport,
    saveVerificationTier,
    saveTaxConfig,
    saveDeviceTrust,
    betaReadiness,
    betaSupportTickets,
    betaForm,
    setBetaForm,
    loadBetaReadiness,
    updateBetaAccess,
    enableBetaFlags,
    recordBetaDeviceTest,
    createBetaSupportTicket,
    updateBetaSupportTicketStatus,
    recordBetaTelemetry,
    launchReadiness,
    launchIncidents,
    launchForm,
    setLaunchForm,
    loadLaunchReadiness,
    updateLaunchSettings,
    updateLaunchChecklist,
    createLaunchIncident,
    updateLaunchIncidentStatus
  } = input.readinessState;
  const { reportSummary, knowledgeSummary, loadReports } = input.reportsState;
  const { notificationInbox, loadNotifications, updateNotification } = input.notificationState;
  const { storefrontCareRequests, storefrontMessages, storefrontOrders, loadStorefrontInbox } =
    input.storefrontCareState;
  const { navigateToView, setRoutedProductId, openProduct } = input.navigationState;
  const { setChatMessages, setRuntimeSessionId } = input.chatThreadState;

  switch (view) {
    case "products":
      return (
        <ProductSurface
          businessId={businessId}
          products={products}
          form={productForm}
          stockProductId={stockProductId}
          stockQuantityAfter={stockQuantityAfter}
          stockReason={stockReason}
          onFormChange={setProductForm}
          onSave={() => void runAction("product-save", saveProduct)}
          onReset={() => {
            setProductForm(emptyProductForm);
            setRoutedProductId(null);
            navigateToView("products", { replace: true, mode: "seller" });
          }}
          onAdd={() => {
            setProductForm(emptyProductForm);
            setRoutedProductId(null);
            navigateToView("products", { replace: true, mode: "seller" });
          }}
          onEdit={openProduct}
          onStockProductChange={(productId) => {
            const product = products.find((item) => item.id === productId);
            setStockProductId(productId);
            setStockQuantityAfter(String(product?.quantity ?? 0));
          }}
          onStockQuantityAfterChange={setStockQuantityAfter}
          onStockReasonChange={setStockReason}
          onAdjustStock={() => void runAction("stock-adjust", adjustStock)}
          onPublished={() => loadProducts(businessId)}
          onRemove={(productId) => void runAction("product-delete", () => deleteProduct(productId))}
        />
      );
    case "suppliers":
      return (
        <Screens.SupplierSurface
          businessId={businessId}
          suppliers={suppliers}
          purchaseReceipts={purchaseReceipts}
          receiptOcrJobs={receiptOcrJobs}
          form={supplierForm}
          onFormChange={setSupplierForm}
          onSave={() => void runAction("supplier-save", saveSupplier)}
          onReset={() => setSupplierForm(emptySupplierForm)}
          onEdit={(supplier) =>
            setSupplierForm({
              id: supplier.id,
              name: supplier.name,
              phone: supplier.phone ?? "",
              email: supplier.email ?? "",
              notes: supplier.notes ?? ""
            })
          }
          onDelete={(supplierId) =>
            void runAction("supplier-delete", () => deleteSupplierCard(supplierId))
          }
          onSaveSalesAgent={(supplierId, agent) =>
            void runAction("sales-agent-save", () => saveSalesAgent(supplierId, agent))
          }
          onDeleteSalesAgent={(supplierId, salesAgentId) =>
            void runAction("sales-agent-delete", () =>
              deleteSalesAgentCard(supplierId, salesAgentId)
            )
          }
          onSearchContacts={searchSupplierContacts}
          onLinkSupplierContact={(supplierId, networkNodeId) =>
            void linkSupplierPhoneContact(supplierId, networkNodeId)
          }
          onCreateSupplierFromContact={(networkNodeId) =>
            void createSupplierFromPhoneContact(networkNodeId)
          }
          onLinkSalesAgentContact={(salesAgentId, networkNodeId) =>
            void linkSalesAgentPhoneContact(salesAgentId, networkNodeId)
          }
          onCreateSalesAgentFromContact={(supplierId, networkNodeId) =>
            void createSalesAgentFromPhoneContact(supplierId, networkNodeId)
          }
          onUploadReceipt={uploadSupplierReceipt}
          onConfirmReceipt={(job) =>
            void runAction("receipt-confirm", () => confirmSupplierReceipt(job))
          }
          onImport={() => navigateToView("imports")}
        />
      );
    case "customers":
      return (
        <CustomerSurface
          businessId={businessId}
          customers={customers}
          form={customerForm}
          onFormChange={setCustomerForm}
          onSave={() => void runAction("customer-save", saveCustomer)}
          onReset={() => setCustomerForm(emptyCustomerForm)}
          onEdit={(customer) =>
            setCustomerForm({
              id: customer.id,
              name: customer.name,
              phone: customer.phone ?? "",
              email: customer.email ?? "",
              notes: customer.notes ?? ""
            })
          }
        />
      );
    case "pos":
      return (
        <Screens.PosTerminal
          businessId={businessId}
          products={products}
          customers={customers}
          onOpenInvoices={() => navigateToView("invoices")}
          onOpenPayments={() => navigateToView("payments")}
          onSaleCompleted={async () => {
            await Promise.all([
              loadProducts(businessId),
              loadInvoices(businessId),
              loadPaymentData(businessId),
              loadReports(businessId),
              loadNotifications(businessId)
            ]);
          }}
        />
      );
    case "invoices":
      return (
        <InvoiceSurface
          products={products}
          customers={customers}
          invoices={invoices}
          form={invoiceForm}
          preview={invoicePreview}
          onFormChange={setInvoiceForm}
          onPreview={() => void runAction("invoice-preview", previewInvoice)}
          onSave={() => void runAction("invoice-save", saveInvoice)}
          onReset={() => {
            setInvoiceForm(emptyInvoiceForm);
            setInvoicePreview(null);
          }}
          onEdit={(invoice) => {
            const firstItem = invoice.items[0];
            setInvoiceForm({
              id: invoice.id,
              customerId: invoice.customerId ?? "",
              customerName: invoice.customerName ?? "",
              productId: firstItem?.productId ?? "",
              quantity: String(firstItem?.quantity ?? 1),
              unitPrice: String(firstItem?.unitPrice ?? 0),
              taxRate: String(invoice.taxRate)
            });
            setInvoicePreview(invoice);
          }}
          onConfirm={(invoiceId) =>
            void runAction("invoice-confirm", () => confirmInvoice(invoiceId))
          }
          onPrint={printInvoice}
        />
      );
    case "sync":
      return (
        <SyncSurface
          summary={syncSummary}
          items={syncQueue}
          offlineCache={offlineCache}
          storefrontUrl={publicStorefrontUrl}
          onInvite={() => void shareOwnerStorefrontInvite()}
          onSyncContacts={() => void syncOwnerPhoneContacts(setChatMessages)}
          onImportContacts={(event) => void importContactsFile(event)}
          onExportContacts={exportOwnerContacts}
          onRefresh={() => {
            void loadSyncQueue(businessId);
            void loadOfflineCache(businessId);
          }}
          onReplay={() =>
            void runAction("sync-replay", () =>
              replaySyncQueue({
                loadProducts,
                loadCustomers,
                loadInvoices,
                loadPaymentData,
                loadLogistics
              })
            )
          }
          onReplayItem={(syncItemId) =>
            void runAction("sync-replay-item", () =>
              replaySyncQueueItem(syncItemId, {
                loadProducts,
                loadCustomers,
                loadInvoices,
                loadPaymentData,
                loadLogistics
              })
            )
          }
        />
      );
    case "runtime":
      return (
        <RuntimeSurface
          sessions={runtimeSessions}
          selectedSessionId={selectedRuntimeHistorySessionId}
          turns={runtimeTurns}
          onCreateSession={() =>
            void runAction("runtime-session-create", () =>
              createRuntimeHistorySession(setRuntimeSessionId)
            )
          }
          onRefresh={() => void loadRuntimeSessions(businessId)}
          onSelectSession={(sessionId) => {
            setSelectedRuntimeHistorySessionId(sessionId);
            void loadRuntimeTurns(businessId, sessionId);
          }}
        />
      );
    case "payments":
      return (
        <PaymentSurface
          invoices={invoices}
          payments={payments}
          invoicePayments={invoicePayments}
          customerDebts={customerDebts}
          form={paymentForm}
          onFormChange={setPaymentForm}
          onRecord={() => void runAction("payment-record", recordPayment)}
          onRefresh={() => void loadPaymentData(businessId)}
        />
      );
    case "imports":
      return (
        <Screens.ImportSurface
          form={importForm}
          importJobs={importJobs}
          activeImportJob={activeImportJob}
          selectedImportJobId={selectedImportJobId}
          onFormChange={setImportForm}
          onCreate={() => void runAction("import-create", createDocumentImport)}
          onSelectJob={setSelectedImportJobId}
          onRowChange={updateImportRowLocal}
          onSaveRow={(job, row) => void runAction("import-row-save", () => saveImportRow(job, row))}
          onConfirm={(job) => void runAction("import-confirm", () => confirmImport(job))}
          onRefresh={() => void loadDocumentImports(businessId)}
        />
      );
    case "logistics":
      return (
        <Screens.LogisticsSurface
          businessId={businessId}
          viewerPermissions={input.businessPermissions}
          invoices={invoices}
          logistics={logistics}
          form={logisticsForm}
          onFormChange={setLogisticsForm}
          onCreate={() => void runAction("logistics-create", createLogistics)}
          onStatusChange={(logisticsId, status) =>
            void runAction("logistics-status", () => updateLogisticsStatus(logisticsId, status))
          }
          onRefresh={() => void loadLogistics(businessId)}
        />
      );
    case "compliance":
      return (
        <Screens.ComplianceSurface
          form={complianceForm}
          securityReview={securityReview}
          dataExport={dataExport}
          verification={verificationTier}
          taxConfig={taxConfig}
          deviceTrust={deviceTrust}
          onFormChange={setComplianceForm}
          onExport={() => void runAction("compliance-export", createDataExport)}
          onSaveVerification={() => void runAction("compliance-verification", saveVerificationTier)}
          onSaveTax={() => void runAction("compliance-tax", saveTaxConfig)}
          onSaveDeviceTrust={() => void runAction("compliance-device", saveDeviceTrust)}
          onRefresh={() => void loadCompliance(businessId)}
        />
      );
    case "beta":
      return (
        <Screens.BetaSurface
          form={betaForm}
          readiness={betaReadiness}
          supportTickets={betaSupportTickets}
          onFormChange={setBetaForm}
          onUpdateAccess={() => void runAction("beta-access", updateBetaAccess)}
          onEnableFlags={() => void runAction("beta-flags", enableBetaFlags)}
          onRecordDeviceTest={() => void runAction("beta-device", recordBetaDeviceTest)}
          onCreateSupportTicket={() =>
            void runAction("beta-ticket-create", createBetaSupportTicket)
          }
          onUpdateSupportTicket={(supportTicketId, status) =>
            void runAction("beta-ticket-update", () =>
              updateBetaSupportTicketStatus(supportTicketId, status)
            )
          }
          onRecordTelemetry={() => void runAction("beta-telemetry", recordBetaTelemetry)}
          onRefresh={() => void loadBetaReadiness(businessId)}
        />
      );
    case "launch":
      return (
        <Screens.LaunchSurface
          form={launchForm}
          readiness={launchReadiness}
          incidents={launchIncidents}
          onFormChange={setLaunchForm}
          onUpdateSettings={() => void runAction("launch-settings", updateLaunchSettings)}
          onUpdateChecklist={() => void runAction("launch-checklist", updateLaunchChecklist)}
          onCreateIncident={() => void runAction("launch-incident-create", createLaunchIncident)}
          onUpdateIncident={(incidentId, status) =>
            void runAction("launch-incident-update", () =>
              updateLaunchIncidentStatus(incidentId, status)
            )
          }
          onRefresh={() => void loadLaunchReadiness(businessId)}
        />
      );
    case "reports":
      return (
        <ReportsSurface
          report={reportSummary}
          knowledge={knowledgeSummary}
          onRefresh={() => void loadReports(businessId)}
        />
      );
    case "notifications":
      return (
        <NotificationsSurface
          careRequests={storefrontCareRequests}
          inbox={notificationInbox}
          messages={storefrontMessages}
          orders={storefrontOrders}
          onRefresh={() => {
            void loadNotifications(businessId);
            void loadStorefrontInbox(businessId);
          }}
          onUpdate={(notificationId, status) =>
            void runAction("notification-update", () => updateNotification(notificationId, status))
          }
        />
      );
    default:
      return null;
  }
}

function renderNetworkWorkspace(input: OwnerWorkspaceBindings) {
  const { businessId, networkState: network, authState: auth } = input;
  const { runAction } = input.asyncActions;
  return (
    <NetworkSurface
      businessId={businessId}
      onboarding={input.networkOnboarding}
      graph={network.networkGraph}
      invites={network.networkInvites}
      providers={auth.oauthProviders}
      onRefresh={() => {
        void network.loadNetworkGraph();
        if (businessId !== null) void network.loadNetworkInvites(businessId);
      }}
      onSyncContacts={() => void runAction("network-sync", network.syncPhoneNetwork)}
      onSyncSocial={(provider) =>
        void runAction("network-social", () =>
          network.syncSocialNetwork(provider, auth.authenticateSocialProfile)
        )
      }
      onRoute={(targetNodeId) =>
        void runAction("network-route", () => network.requestNetworkRoute(targetNodeId))
      }
      onApproveRoute={(id) =>
        void runAction("network-route-approve", () => network.approveNetworkRoute(id))
      }
      onRejectRoute={(id) =>
        void runAction("network-route-reject", () => network.rejectNetworkRoute(id))
      }
      onDisconnectSource={(id) =>
        void runAction("network-disconnect", () => network.disconnectNetworkSource(id))
      }
    />
  );
}
