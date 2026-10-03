import { useEffect, useState } from "react";

import type { DeviceSessionSummary } from "@grogoni/shared-types";

import { deleteJson, getJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";
import { formatDate } from "./formatters";

export interface NotificationsSessionsPanelProps {
  accountId: string;
  businessId: string;
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  setProfileMessage: (message: string) => void;
  onEnableNotifications: () => Promise<void>;
  onDisableNotifications: () => Promise<void>;
  onLogout: () => void;
  onLogoutAll: () => void;
  isLoggingOut: boolean;
}

export function NotificationsSessionsPanel({
  accountId,
  businessId,
  pendingProfileAction,
  runProfileAction,
  setProfileMessage,
  onEnableNotifications,
  onDisableNotifications,
  onLogout,
  onLogoutAll,
  isLoggingOut
}: NotificationsSessionsPanelProps) {
  const [deviceSessions, setDeviceSessions] = useState<DeviceSessionSummary[]>([]);

  async function loadDeviceSessions() {
    try {
      const response = await getJson<{ sessions: DeviceSessionSummary[] }>("/auth/sessions");
      setDeviceSessions(response.sessions);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function revokeDeviceSession(sessionId: string) {
    const revoked = await deleteJson<DeviceSessionSummary>(
      `/auth/sessions/${encodeURIComponent(sessionId)}`
    );
    if (revoked.current) {
      onLogout();
      return;
    }
    await loadDeviceSessions();
    setProfileMessage("The selected device session was revoked.");
  }

  useEffect(() => {
    void loadDeviceSessions();
  }, [accountId, businessId]);

  return (
    <div className="record-form shop-profile-card">
      <div className="section-heading">
        <p className="eyebrow">Devices and sessions</p>
        <h3>Notifications and account sessions</h3>
      </div>
      <p className="shell-note">
        Control push delivery on this device, or revoke every signed-in session if a device is lost.
      </p>
      <div className="connected-social-list" role="list" aria-label="Signed-in devices">
        {deviceSessions.map((deviceSession) => (
          <article className="connected-social-card" role="listitem" key={deviceSession.id}>
            <div>
              <span>{deviceSession.current ? "This device" : "Signed-in device"}</span>
              <strong>{deviceSession.deviceName}</strong>
              <p>
                {deviceSession.platform} · {deviceSession.browserOrApp} · {deviceSession.status}
              </p>
            </div>
            <div className="connected-social-meta">
              <span>Last active: {formatDate(deviceSession.lastUsedAt)}</span>
              <span>Expires: {formatDate(deviceSession.expiresAt)}</span>
            </div>
            <button
              className="secondary"
              type="button"
              disabled={deviceSession.status !== "active" || pendingProfileAction !== null}
              onClick={() =>
                void runProfileAction("device-session-revoke", () =>
                  revokeDeviceSession(deviceSession.id)
                )
              }
            >
              {deviceSession.current ? "Log out this device" : "Log out device"}
            </button>
          </article>
        ))}
      </div>
      <div className="row-actions">
        <button
          type="button"
          disabled={pendingProfileAction !== null}
          onClick={() => void runProfileAction("push-enable", async () => onEnableNotifications())}
        >
          Enable notifications
        </button>
        <button
          className="secondary"
          type="button"
          disabled={pendingProfileAction !== null}
          onClick={() =>
            void runProfileAction("push-disable", async () => onDisableNotifications())
          }
        >
          Disable on this device
        </button>
        <button
          className="destructive-button"
          type="button"
          disabled={pendingProfileAction !== null || isLoggingOut}
          onClick={onLogoutAll}
          aria-busy={isLoggingOut}
        >
          {isLoggingOut ? "Signing out all devices…" : "Sign out all devices"}
        </button>
      </div>
    </div>
  );
}
