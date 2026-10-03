import type {
  BusinessNotificationSummary,
  BusinessNotificationType,
  NotificationInbox
} from "@grogoni/shared-types";

/**
 * `ensureDeterministicNotifications` upserts each rule-based notification under a ruleKey
 * that is NOT `businessId:type` - it's a distinct, hand-picked dotted string per rule (e.g.
 * `beta_readiness` notifications use ruleKey suffix `beta.readiness`, not `beta_readiness`).
 * Rebuilding `notificationByRuleKey` after a restore/purge therefore has to reconstruct that
 * exact same key, or every subsequent `ensureDeterministicNotifications` call fails its
 * "does this rule already have a notification" lookup and creates a duplicate instead of
 * upserting in place. This function is the single source of truth for that reconstruction,
 * used both by the initial write (indirectly, via the literal ruleKeys below) and by every
 * index-rebuild site.
 */
function deterministicNotificationRuleKeySuffix(type: BusinessNotificationType): string {
  switch (type) {
    case "low_stock":
      return "inventory.low_stock";
    case "open_debt":
      return "debt.open";
    case "sync_conflict":
      return "sync.conflict";
    case "import_failed":
      return "import.failed";
    case "fulfillment_pending":
      return "logistics.pending";
    case "beta_readiness":
      return "beta.readiness";
    case "launch_readiness":
      return "launch.readiness";
    case "security_event":
    case "shop_deletion":
      return type;
  }
}

/**
 * Reconstructs the ruleKey a notification would have been upserted under, purely from its
 * already-persisted fields - no schema change needed. Security/shop-deletion notifications
 * (the only ones with a non-null `sourceId`) use `businessId:type:sourceId`, matching
 * `recordSecurityNotification`. Everything else is one of the seven deterministic rules
 * above, whose suffix is a fixed function of `type`.
 */
export function notificationRuleKey(notification: BusinessNotificationSummary): string {
  if (notification.sourceId !== null) {
    return `${notification.businessId}:${notification.type}:${notification.sourceId}`;
  }
  return `${notification.businessId}:${deterministicNotificationRuleKeySuffix(notification.type)}`;
}

export function summarizeNotifications(
  businessId: string,
  notifications: BusinessNotificationSummary[]
): NotificationInbox["summary"] {
  const summary = {
    businessId,
    unread: 0,
    read: 0,
    archived: 0,
    total: notifications.length
  };

  for (const notification of notifications) {
    summary[notification.status] += 1;
  }

  return summary;
}
