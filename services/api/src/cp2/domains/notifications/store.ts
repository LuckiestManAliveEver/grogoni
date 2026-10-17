/**
 * Fifth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns the `notifications` and
 * `notificationByRuleKey` entity Maps - in-app business notifications and the derived
 * index used to dedupe/update rule-based notifications by a composite key.
 *
 * The roadmap flagged this domain as needing "event/observer design, not a mechanical
 * deps-copy" because notifications looked like a write sink for many other domains.
 * Reading every call site (not just the Map names) during this extraction showed that
 * assumption was wrong for the code as it exists today: nothing in any of the four
 * already-extracted domains (commerce, compliance, logistics, suppliers, document-imports)
 * writes a notification. Every write happens inside Cp2Store itself, through exactly two
 * paths - `recordSecurityNotification` (called from the shop-deletion request/finalize
 * flow) and the lazy `ensureDeterministicNotifications` recompute (called from
 * `buildBusinessKnowledge`, which itself depends on `buildBusinessReport`, a cross-cutting
 * aggregator that reads every domain's public accessors). So no event bus or observer
 * registry is needed yet - a plain constructor-injected `buildBusinessReport` callback is
 * sufficient. If a future domain needs to raise a notification directly, add a callback to
 * `NotificationsDomainDeps` for it rather than reaching into this domain's private Maps.
 *
 * `buildBusinessKnowledge`, `auditEventsForBusiness`, `buildShopDeletionPreview`, and
 * `createDataExport` stay on Cp2Store (cross-cutting reads/builders per the established
 * pattern) and call this domain's public `ensureDeterministicNotifications`/
 * `sortedNotifications`/`recordSecurityNotification` accessors instead of touching the
 * Maps directly.
 *
 * Pre-existing bug found and fixed during this extraction: the derived-index rebuild (on
 * snapshot hydrate and after an account purge) used to recompute `notificationByRuleKey`
 * as `businessId:type`, but no notification is ever written under that key -
 * `ensureDeterministicNotifications` uses seven distinct hand-picked dotted keys (e.g.
 * `beta.readiness`, not `beta_readiness`) and `recordSecurityNotification` uses
 * `businessId:type:sourceId`. That meant the rebuilt index never matched any real entry, so
 * every store restart (and every account purge) silently duplicated all seven deterministic
 * notifications the next time they were recomputed. A live-Postgres persistence test caught
 * this directly (restart produced 4 notifications instead of 2). Fixed by reconstructing the
 * exact original ruleKey from already-persisted fields - see `notificationRuleKey` in
 * `./shared.ts` - used everywhere the index is rebuilt, not just here.
 */
import { randomUUID } from "node:crypto";
import type { BusinessPermission } from "@grogoni/business-core";
import type {
  AuthenticatedActorView,
  BusinessNotificationStatus,
  BusinessNotificationSummary,
  BusinessReportSummary,
  NotificationInbox
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { notificationRuleKey, summarizeNotifications } from "./shared.js";

export interface NotificationsDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  buildBusinessReport: (businessId: string, now: Date) => BusinessReportSummary;
}

export class NotificationsDomain {
  private readonly notifications = new Map<string, BusinessNotificationSummary>();
  private readonly notificationByRuleKey = new Map<string, string>();

  constructor(private readonly deps: NotificationsDomainDeps) {}

  get notificationsMap(): Map<string, BusinessNotificationSummary> {
    return this.notifications;
  }

  get notificationByRuleKeyMap(): Map<string, string> {
    return this.notificationByRuleKey;
  }

  clear(): void {
    this.notifications.clear();
    this.notificationByRuleKey.clear();
  }

  rebuildNotificationByRuleKeyIndex(): void {
    this.notificationByRuleKey.clear();
    for (const notification of this.notifications.values()) {
      this.notificationByRuleKey.set(notificationRuleKey(notification), notification.id);
    }
  }

  listNotifications(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): NotificationInbox {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "notification:read", now);
    this.ensureDeterministicNotifications(input.businessId, now);
    const notifications = this.sortedNotifications(input.businessId);

    return {
      summary: summarizeNotifications(input.businessId, notifications),
      notifications
    };
  }

  updateNotificationStatus(input: {
    sessionId: string | null;
    businessId: string;
    notificationId: string;
    status: BusinessNotificationStatus;
    now?: Date;
  }): BusinessNotificationSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "notification:write",
      now
    );
    this.ensureDeterministicNotifications(input.businessId, now);
    const notification = this.notifications.get(input.notificationId);

    if (notification === undefined || notification.businessId !== input.businessId) {
      throw new Cp2Error(404, "notification_not_found", "Notification was not found.");
    }

    const updated: BusinessNotificationSummary = {
      ...notification,
      status: input.status,
      updatedAt: now.toISOString(),
      readAt:
        input.status === "read"
          ? (notification.readAt ?? now.toISOString())
          : input.status === "archived"
            ? (notification.readAt ?? now.toISOString())
            : null,
      archivedAt:
        input.status === "archived" ? (notification.archivedAt ?? now.toISOString()) : null
    };

    this.notifications.set(updated.id, updated);
    this.deps.recordAuditEvent({
      type: "notification.status_updated",
      aggregateType: "notification",
      aggregateId: updated.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId,
        status: updated.status,
        type: updated.type
      }
    });

    return updated;
  }

  ensureDeterministicNotifications(businessId: string, now: Date): void {
    const report = this.deps.buildBusinessReport(businessId, now);

    if (report.inventory.outOfStockCount > 0 || report.inventory.lowStockCount > 0) {
      this.upsertNotification({
        businessId,
        ruleKey: `${businessId}:inventory.low_stock`,
        type: "low_stock",
        severity: report.inventory.outOfStockCount > 0 ? "critical" : "warning",
        title: "Inventory needs attention",
        body: `${report.inventory.lowStockCount} low-stock products and ${report.inventory.outOfStockCount} out of stock.`,
        sourceType: "report",
        sourceId: null,
        now
      });
    }

    if (report.debts.totalOutstanding > 0) {
      this.upsertNotification({
        businessId,
        ruleKey: `${businessId}:debt.open`,
        type: "open_debt",
        severity: "warning",
        title: "Open customer debt",
        body: `${report.debts.customerCount} customers owe ${report.debts.totalOutstanding}.`,
        sourceType: "report",
        sourceId: null,
        now
      });
    }

    if (report.sync.conflict > 0) {
      this.upsertNotification({
        businessId,
        ruleKey: `${businessId}:sync.conflict`,
        type: "sync_conflict",
        severity: "critical",
        title: "Sync conflicts need review",
        body: `${report.sync.conflict} queued sync item${report.sync.conflict === 1 ? "" : "s"} have conflicts.`,
        sourceType: "sync_queue",
        sourceId: null,
        now
      });
    }

    if (report.imports.failedJobs > 0) {
      this.upsertNotification({
        businessId,
        ruleKey: `${businessId}:import.failed`,
        type: "import_failed",
        severity: "warning",
        title: "Import failed",
        body: `${report.imports.failedJobs} document import job${report.imports.failedJobs === 1 ? "" : "s"} failed.`,
        sourceType: "document_import",
        sourceId: null,
        now
      });
    }

    if (report.logistics.pendingCount > 0 || report.logistics.readyCount > 0) {
      this.upsertNotification({
        businessId,
        ruleKey: `${businessId}:logistics.pending`,
        type: "fulfillment_pending",
        severity: "warning",
        title: "Fulfillment work is open",
        body: `${report.logistics.pendingCount} pending and ${report.logistics.readyCount} ready fulfillment records need attention.`,
        sourceType: "logistics",
        sourceId: null,
        now
      });
    }

    if (report.beta.status !== "ready") {
      this.upsertNotification({
        businessId,
        ruleKey: `${businessId}:beta.readiness`,
        type: "beta_readiness",
        severity: report.beta.status === "blocked" ? "critical" : "warning",
        title: "Beta readiness needs review",
        body: `${report.beta.gates.filter((gate) => !gate.passed).length} CP15 release gates need attention.`,
        sourceType: "beta_readiness",
        sourceId: null,
        now
      });
    }

    if (report.launch.status !== "ready") {
      this.upsertNotification({
        businessId,
        ruleKey: `${businessId}:launch.readiness`,
        type: "launch_readiness",
        severity: report.launch.status === "blocked" ? "critical" : "warning",
        title: "Public launch readiness needs review",
        body: `${report.launch.gates.filter((gate) => !gate.passed).length} CP16 launch gates need attention.`,
        sourceType: "launch_readiness",
        sourceId: null,
        now
      });
    }
  }

  recordSecurityNotification(input: {
    businessId: string;
    type: BusinessNotificationSummary["type"];
    title: string;
    body: string;
    sourceId: string;
    now: Date;
  }): void {
    this.upsertNotification({
      businessId: input.businessId,
      ruleKey: `${input.businessId}:${input.type}:${input.sourceId}`,
      type: input.type,
      severity: "critical",
      title: input.title,
      body: input.body,
      sourceType: input.type === "shop_deletion" ? "shop_deletion" : "security",
      sourceId: input.sourceId,
      now: input.now
    });
  }

  sortedNotifications(businessId: string): BusinessNotificationSummary[] {
    return [...this.notifications.values()]
      .filter((notification) => notification.businessId === businessId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private upsertNotification(input: {
    businessId: string;
    ruleKey: string;
    type: BusinessNotificationSummary["type"];
    severity: BusinessNotificationSummary["severity"];
    title: string;
    body: string;
    sourceType: BusinessNotificationSummary["sourceType"];
    sourceId: string | null;
    now: Date;
  }): void {
    const existingId = this.notificationByRuleKey.get(input.ruleKey);
    const existing = existingId === undefined ? undefined : this.notifications.get(existingId);

    if (existing !== undefined) {
      if (existing.status === "archived") {
        return;
      }
      // Re-evaluating a rule that still says the same thing changes nothing. These rules run on
      // every request; re-stamping updatedAt each time made concurrent requests for the shop
      // conflict on these rows (40001), and a send answered 503.
      if (
        existing.severity === input.severity &&
        existing.title === input.title &&
        existing.body === input.body
      ) {
        return;
      }

      this.notifications.set(existing.id, {
        ...existing,
        severity: input.severity,
        title: input.title,
        body: input.body,
        updatedAt: input.now.toISOString()
      });
      return;
    }

    const notification: BusinessNotificationSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      type: input.type,
      severity: input.severity,
      status: "unread",
      title: input.title,
      body: input.body,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      readAt: null,
      archivedAt: null
    };

    this.notifications.set(notification.id, notification);
    this.notificationByRuleKey.set(input.ruleKey, notification.id);
    this.deps.recordAuditEvent({
      type: "notification.created",
      aggregateType: "notification",
      aggregateId: notification.id,
      actorId: "system",
      occurredAt: input.now.toISOString(),
      payload: {
        businessId: input.businessId,
        type: notification.type,
        severity: notification.severity
      }
    });
  }
}
