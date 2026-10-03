import { type ChangeEvent } from "react";

import {
  type OfflineCacheSnapshot,
  type SyncQueueItem,
  type SyncQueueSummary
} from "./grogoni-application-shared";

import { EmptyStateSurface } from "./EmptyStateSurface";

export interface SyncSurfaceProps {
  summary: SyncQueueSummary;
  items: SyncQueueItem[];
  offlineCache: OfflineCacheSnapshot | null;
  storefrontUrl: string;
  onInvite: () => void;
  onExportContacts: () => void;
  onImportContacts: (event: ChangeEvent<HTMLInputElement>) => void;
  onRefresh: () => void;
  onReplay: () => void;
  onReplayItem: (syncItemId: string) => void;
  onSyncContacts: () => void;
}

export function SyncSurface(props: SyncSurfaceProps) {
  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Sync queue actions">
        <div className="section-heading">
          <p className="eyebrow">Sync</p>
          <h3>Offline queue</h3>
        </div>
        <div className="metric-grid compact">
          <div className="metric">
            <span>Pending</span>
            <strong>{props.summary.pending}</strong>
          </div>
          <div className="metric">
            <span>Conflicts</span>
            <strong>{props.summary.conflict}</strong>
          </div>
          <div className="metric">
            <span>Failed</span>
            <strong>{props.summary.failed}</strong>
          </div>
          <div className="metric">
            <span>Synced</span>
            <strong>{props.summary.synced}</strong>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={props.onReplay} disabled={props.summary.total === 0}>
            Retry queue
          </button>
          <button className="secondary" type="button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
        <div className="sync-share-panel">
          <div>
            <span>My Network</span>
            <strong>Contacts and invites</strong>
            <p>{props.storefrontUrl}</p>
          </div>
          <div className="sync-share-actions">
            <button type="button" onClick={props.onSyncContacts}>
              Sync contacts
            </button>
            <button className="secondary" type="button" onClick={props.onInvite}>
              Invite link
            </button>
            <label className="secondary file-action">
              Import contacts
              <input accept=".csv,.vcf,.txt,text/*" type="file" onChange={props.onImportContacts} />
            </label>
            <button className="secondary" type="button" onClick={props.onExportContacts}>
              Export contacts
            </button>
          </div>
        </div>
      </section>

      <section className="record-list" aria-label="Offline cache">
        <div className="surface-header-row">
          <div className="section-heading">
            <p className="eyebrow">Offline cache</p>
            <h3>Server snapshot available on device</h3>
          </div>
          <button className="secondary" type="button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
        {props.offlineCache === null ? (
          <div className="empty-record">
            <h3>No cache snapshot loaded</h3>
            <p>Refresh sync to load the current offline-readable business snapshot.</p>
          </div>
        ) : (
          <>
            <p className="shell-note">
              Captured {new Date(props.offlineCache.capturedAt).toLocaleString()}
            </p>
            <div className="metric-grid compact">
              <div className="metric">
                <span>Products</span>
                <strong>{props.offlineCache.products.length}</strong>
              </div>
              <div className="metric">
                <span>Customers</span>
                <strong>{props.offlineCache.customers.length}</strong>
              </div>
              <div className="metric">
                <span>Suppliers</span>
                <strong>{props.offlineCache.suppliers.length}</strong>
              </div>
              <div className="metric">
                <span>Invoices</span>
                <strong>{props.offlineCache.invoices.length}</strong>
              </div>
              <div className="metric">
                <span>Payments</span>
                <strong>{props.offlineCache.payments.length}</strong>
              </div>
              <div className="metric">
                <span>Movements</span>
                <strong>{props.offlineCache.inventoryMovements.length}</strong>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="record-list" aria-label="Sync queue list">
        {props.items.length === 0 ? (
          <EmptyStateSurface
            title="No queued work"
            body="Offline mutations will appear here until server replay confirms or rejects them."
            onChat={props.onRefresh}
            actionLabel="Refresh"
          />
        ) : (
          props.items.map((item) => (
            <article className="record-row" key={item.id}>
              <div>
                <p className="eyebrow">{item.status}</p>
                <h4>{item.mutationType}</h4>
                <p>{new Date(item.clientCreatedAt).toLocaleString()}</p>
                {item.conflict !== null ? <p>{item.conflict.message}</p> : null}
              </div>
              <div className="row-actions compact-actions">
                <strong>{item.attempts}</strong>
                {item.status === "failed" || item.status === "conflict" ? (
                  <button type="button" onClick={() => props.onReplayItem(item.id)}>
                    Retry
                  </button>
                ) : null}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
