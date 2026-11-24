import { useState } from "react";
import type { MutedShopSummary } from "@grogoni/shared-types";
import { apiCloudFetch } from "./lib/api";
import { networkChangedEvent } from "./phonebook-sync";

interface Privacy {
  discoverable: boolean;
  blockedContacts: Array<{ userId: string; name: string }>;
}

export function NetworkPrivacyControls() {
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  // Shops whose status updates this person turned off (from the marketplace feed).
  const [mutedShops, setMutedShops] = useState<MutedShopSummary[]>([]);
  async function loadMutedShops() {
    try {
      setMutedShops(
        (await apiCloudFetch<{ mutedShops: MutedShopSummary[] }>("/v1/broadcast-preferences"))
          .mutedShops
      );
    } catch {
      // The rest of the panel still works; the list stays as it was.
    }
  }
  async function unmute(shop: MutedShopSummary) {
    setBusy(true);
    try {
      await apiCloudFetch(`/v1/broadcast-preferences/${encodeURIComponent(shop.businessId)}`, {
        method: "PUT",
        body: { receive: true }
      });
      setMutedShops((current) => current.filter((item) => item.businessId !== shop.businessId));
      setStatus(`Updates from ${shop.businessName} are on again.`);
    } catch {
      setStatus("Shop updates could not be turned back on. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function update(
    path = "/network/privacy",
    method = "GET",
    body?: { discoverable: boolean }
  ) {
    setBusy(true);
    try {
      setPrivacy(
        await apiCloudFetch<Privacy>(path, {
          method,
          ...(method === "GET" ? {} : { body: body ?? {} })
        })
      );
      setStatus("");
      if (method !== "GET") window.dispatchEvent(new Event(networkChangedEvent));
    } catch {
      setStatus("Contact privacy settings could not be saved or loaded. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) {
          void update();
          void loadMutedShops();
        }
      }}
    >
      <summary>Contact privacy and blocked people</summary>
      {privacy ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={privacy.discoverable}
              disabled={busy}
              onChange={(event) =>
                void update("/network/privacy", "PATCH", { discoverable: event.target.checked })
              }
            />
            Let people who have my number or email find me
          </label>
          <p>
            Blocking stops new direct messages and contact matching in both directions. Existing
            history is retained.
          </p>
          {privacy.blockedContacts.map((contact) => (
            <p key={contact.userId}>
              {contact.name}{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void update(`/network/blocks/${encodeURIComponent(contact.userId)}`, "DELETE")
                }
              >
                Unblock {contact.name}
              </button>
            </p>
          ))}
          {mutedShops.length > 0 ? (
            <>
              <p>Shops whose updates you turned off. They cannot send you new statuses.</p>
              {mutedShops.map((shop) => (
                <p key={shop.businessId}>
                  {shop.businessName}{" "}
                  <button type="button" disabled={busy} onClick={() => void unmute(shop)}>
                    Turn updates from {shop.businessName} back on
                  </button>
                </p>
              ))}
            </>
          ) : null}
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => void update()}>
          Load privacy settings
        </button>
      )}
      {status ? <p role="status">{status}</p> : null}
    </details>
  );
}
