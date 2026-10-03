import { useEffect, useState } from "react";
import type { E2eeDeviceSummary } from "@grogoni/shared-types";
import { ensureE2eeIdentity } from "./e2ee";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { apiFetch } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";

export default function AccountBackendControls(props: {
  accountId: string;
  displayName: string;
  onDisplayNameChanged: (displayName: string) => void;
}) {
  const { isPending, runAction } = useAsyncActions();
  const [displayName, setDisplayName] = useState(props.displayName);
  const [devices, setDevices] = useState<E2eeDeviceSummary[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => setDisplayName(props.displayName), [props.displayName]);

  useEffect(() => {
    let cancelled = false;
    void loadEncryptionDevices(props.accountId).then(
      ({ devices: nextDevices, currentDeviceId: nextCurrentDeviceId }) => {
        if (cancelled) return;
        setDevices(nextDevices);
        setCurrentDeviceId(nextCurrentDeviceId);
      },
      (error: unknown) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [props.accountId]);

  async function saveDisplayName() {
    const response = await apiFetch<{ user: { displayName: string } }>("/account/display-name", {
      method: "PUT",
      body: { displayName }
    });
    setDisplayName(response.user.displayName);
    props.onDisplayNameChanged(response.user.displayName);
    setMessage("Account display name updated.");
  }

  async function revokeEncryptionDevice(deviceId: string) {
    await apiFetch(`/v1/e2ee/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    const next = await loadEncryptionDevices(props.accountId);
    setDevices(next.devices);
    setCurrentDeviceId(next.currentDeviceId);
    setMessage("The selected messaging encryption key was revoked.");
  }

  return (
    <>
      <div className="record-form" role="group" aria-label="Account display name">
        <div className="section-heading">
          <p className="eyebrow">Account profile</p>
          <h4>Display name</h4>
          <p>This name identifies you in account and direct-message experiences.</p>
        </div>
        <label>
          Display name
          <input
            type="text"
            minLength={2}
            maxLength={100}
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={displayName.trim().length < 2 || isPending("display-name")}
          aria-busy={isPending("display-name")}
          onClick={() =>
            void runAction("display-name", async () => {
              try {
                await saveDisplayName();
              } catch (error) {
                setMessage(getUserFacingErrorMessage(error));
              }
            })
          }
        >
          {isPending("display-name") ? "Saving…" : "Save name"}
        </button>
      </div>

      <div className="record-form" role="group" aria-label="Messaging encryption keys">
        <div className="section-heading">
          <p className="eyebrow">End-to-end encryption</p>
          <h4>Messaging keys</h4>
          <p>Revoke the encryption key for a browser or device you no longer use.</p>
        </div>
        <div className="connected-social-list" role="list">
          {devices.length === 0 ? (
            <p className="form-hint" role="listitem">
              No messaging keys are registered yet.
            </p>
          ) : (
            devices.map((device) => {
              const isCurrent = device.id === currentDeviceId;
              return (
                <article className="connected-social-card" role="listitem" key={device.id}>
                  <div>
                    <span>{isCurrent ? "This browser's key" : "Encryption key"}</span>
                    <strong>{device.label}</strong>
                    <p>Last active: {new Date(device.lastSeenAt).toLocaleString()}</p>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    disabled={isCurrent || isPending("encryption-device-revoke")}
                    onClick={() =>
                      void runAction("encryption-device-revoke", async () => {
                        try {
                          await revokeEncryptionDevice(device.id);
                        } catch (error) {
                          setMessage(getUserFacingErrorMessage(error));
                        }
                      })
                    }
                  >
                    {isCurrent ? "Active on this browser" : "Revoke key"}
                  </button>
                </article>
              );
            })
          )}
        </div>
      </div>
      {message.length > 0 ? (
        <p className="shell-note" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </>
  );
}

async function loadEncryptionDevices(accountId: string): Promise<{
  devices: E2eeDeviceSummary[];
  currentDeviceId: string;
}> {
  const identity = await ensureE2eeIdentity(accountId);
  let response = await apiFetch<{ devices: E2eeDeviceSummary[] }>("/v1/e2ee/devices");
  if (!response.devices.some((device) => device.id === identity.deviceId)) {
    const current = await apiFetch<E2eeDeviceSummary>("/v1/e2ee/devices", {
      method: "POST",
      body: {
        deviceId: identity.deviceId,
        label:
          (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ||
          navigator.platform ||
          "This browser",
        publicKey: identity.publicKey
      }
    });
    response = { devices: [...response.devices, current] };
  }
  return { devices: response.devices, currentDeviceId: identity.deviceId };
}
