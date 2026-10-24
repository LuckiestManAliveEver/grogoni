import { useState } from "react";
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
        if (event.currentTarget.open) void update();
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
