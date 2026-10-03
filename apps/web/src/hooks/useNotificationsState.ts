import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, patchJson } from "../api-helpers";
import {
  emptyNotificationSummary,
  type BusinessNotificationSummary,
  type NotificationInbox
} from "../grogoni-application-shared";

interface UseNotificationsStateDeps {
  businessId: string | null;
  setStatusMessage: (message: string) => void;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

const emptyNotificationInbox: NotificationInbox = {
  summary: emptyNotificationSummary,
  notifications: []
};

export function useNotificationsState(deps: UseNotificationsStateDeps) {
  const [notificationInbox, setNotificationInbox] =
    useState<NotificationInbox>(emptyNotificationInbox);

  async function loadNotifications(businessId: string) {
    try {
      setNotificationInbox(
        await getJson<NotificationInbox>(
          `/businesses/${businessId}/notifications`,
          setNotificationInbox
        )
      );
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function updateNotification(
    notificationId: string,
    status: BusinessNotificationSummary["status"]
  ) {
    if (deps.businessId === null) {
      return;
    }

    try {
      await patchJson<BusinessNotificationSummary>(
        `/businesses/${deps.businessId}/notifications/${notificationId}`,
        { status }
      );
      await loadNotifications(deps.businessId);
      deps.setStatusMessage("Notification updated");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  deps.registerReset("notifications", () => setNotificationInbox(emptyNotificationInbox));
  deps.registerRefresh("notifications", ["chat", "home", "notifications"], loadNotifications);

  return { notificationInbox, loadNotifications, updateNotification };
}
