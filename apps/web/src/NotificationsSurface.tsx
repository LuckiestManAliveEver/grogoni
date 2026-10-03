import type {
  PublicCustomerCareRequestSummary,
  PublicOrderSummary,
  PublicStorefrontMessageSummary
} from "@grogoni/shared-types";

import {
  type BusinessNotificationSummary,
  type NotificationInbox
} from "./grogoni-application-shared";

import { formatDate, formatCareRequestType } from "./formatters";

import { EmptyStateSurface } from "./EmptyStateSurface";

export interface NotificationsSurfaceProps {
  careRequests: PublicCustomerCareRequestSummary[];
  inbox: NotificationInbox;
  messages: PublicStorefrontMessageSummary[];
  orders: PublicOrderSummary[];
  onRefresh: () => void;
  onUpdate: (notificationId: string, status: BusinessNotificationSummary["status"]) => void;
}

export function NotificationsSurface({
  careRequests,
  inbox,
  messages,
  orders,
  onRefresh,
  onUpdate
}: NotificationsSurfaceProps) {
  const visibleNotifications = inbox.notifications.filter(
    (notification) => notification.status !== "archived"
  );

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Notification controls">
        <div className="section-heading">
          <p className="eyebrow">Alerts</p>
          <h3>In-app notifications</h3>
        </div>
        <div className="metric-grid compact">
          <div className="metric">
            <span>Unread</span>
            <strong>{inbox.summary.unread}</strong>
          </div>
          <div className="metric">
            <span>Read</span>
            <strong>{inbox.summary.read}</strong>
          </div>
          <div className="metric">
            <span>Archived</span>
            <strong>{inbox.summary.archived}</strong>
          </div>
        </div>
        <button type="button" onClick={onRefresh}>
          Refresh alerts
        </button>
      </section>

      <section className="record-list" aria-label="Notifications">
        {visibleNotifications.length === 0 ? (
          <EmptyStateSurface
            title="No active notifications"
            body="Low stock, open debt, sync conflicts, and failed imports create in-app alerts here."
            onChat={onRefresh}
            actionLabel="Refresh"
          />
        ) : (
          visibleNotifications.map((notification) => (
            <article className="record-row notification-row" key={notification.id}>
              <div>
                <p className="eyebrow">
                  {notification.severity} - {notification.status}
                </p>
                <h4>{notification.title}</h4>
                <p>{notification.body}</p>
              </div>
              <div className="row-actions compact-actions">
                {notification.status === "unread" ? (
                  <button type="button" onClick={() => onUpdate(notification.id, "read")}>
                    Read
                  </button>
                ) : null}
                <button
                  className="secondary"
                  type="button"
                  onClick={() => onUpdate(notification.id, "archived")}
                >
                  Archive
                </button>
              </div>
            </article>
          ))
        )}
      </section>

      <section className="record-list" aria-label="Storefront requests">
        <div className="section-heading">
          <p className="eyebrow">Public storefront</p>
          <h3>Customer requests</h3>
          <p>Messages, care requests, and order requests submitted through your public shop.</p>
        </div>
        {orders.map((order) => (
          <article className="record-row" key={order.id}>
            <div>
              <p className="eyebrow">Order · {order.status}</p>
              <h4>{order.customerName}</h4>
              <p>
                {order.items.map((item) => `${item.quantity} × ${item.productName}`).join(", ")}
              </p>
              <small>
                {order.phone} · {formatDate(order.createdAt)}
              </small>
            </div>
            <strong>{order.items.length} items</strong>
          </article>
        ))}
        {careRequests.map((request) => (
          <article className="record-row" key={request.id}>
            <div>
              <p className="eyebrow">
                {formatCareRequestType(request.type)} · {request.status}
              </p>
              <h4>{request.customerName ?? "Storefront visitor"}</h4>
              <p>{request.message ?? "No message supplied."}</p>
              <small>
                {request.phone ?? "No phone"} · {formatDate(request.createdAt)}
              </small>
            </div>
          </article>
        ))}
        {messages.map((message) => (
          <article className="record-row" key={message.id}>
            <div>
              <p className="eyebrow">Storefront message</p>
              <h4>Visitor {message.visitorId.slice(0, 12)}</h4>
              <p>{message.body}</p>
              <small>
                {formatDate(message.createdAt)}
                {message.attachmentNames.length === 0
                  ? ""
                  : ` · ${message.attachmentNames.length} attachments`}
              </small>
            </div>
          </article>
        ))}
        {orders.length + careRequests.length + messages.length === 0 ? (
          <p className="shell-note">No storefront requests yet.</p>
        ) : null}
      </section>
    </div>
  );
}
