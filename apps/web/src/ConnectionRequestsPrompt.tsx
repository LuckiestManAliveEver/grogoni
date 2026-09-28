import { useEffect, useState } from "react";
import type { NetworkConnectionSummary } from "@soko/shared-types";

import { fetchFreshJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { networkChangedEvent } from "./phonebook-sync";

// Connection requests waiting for the signed-in person (docs/architecture/
// phonebook-identity-resolution.md). Mounted in the app shell next to StaffInvitationsPrompt, so
// someone who was asked to connect sees it on their next visit without opening My Network. Checks
// again when the app comes back to the foreground. Renders nothing when there is nothing to answer.
export default function ConnectionRequestsPrompt(props: { accountId: string }) {
  const [requests, setRequests] = useState<NetworkConnectionSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetchFreshJson<{ connections: NetworkConnectionSummary[] }>("/network/connections")
        .then((loaded) => {
          if (cancelled) return;
          setRequests(
            loaded.connections.filter(
              (connection) => connection.direction === "incoming" && connection.status === "pending"
            )
          );
        })
        .catch(() => {
          // An optional prompt: a failed check (signed out, PIN not verified yet) shows nothing.
        });
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    // A request answered in the Phone Contacts card must disappear here too.
    const onNetworkChanged = (event: Event) => {
      if ((event as CustomEvent<{ source?: string }>).detail?.source !== "prompt") check();
    };
    // A connection push arrived, or its notification was clicked while this window was already in
    // front (which fires no focus event): recheck, and let the network card reload as well.
    const onServiceWorkerMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "network.connection.changed") return;
      window.dispatchEvent(
        new CustomEvent(networkChangedEvent, { detail: { source: "service-worker" } })
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    window.addEventListener(networkChangedEvent, onNetworkChanged);
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
      window.removeEventListener(networkChangedEvent, onNetworkChanged);
      navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage);
    };
  }, [props.accountId]);

  async function answer(request: NetworkConnectionSummary, accept: boolean) {
    setBusyId(request.id);
    setMessage("");
    try {
      await postJson(`/network/connections/${request.id}/respond`, { accept });
      setRequests((current) => current.filter((item) => item.id !== request.id));
      // Tell the network card; this prompt already updated itself.
      window.dispatchEvent(new CustomEvent(networkChangedEvent, { detail: { source: "prompt" } }));
      setMessage(accept ? `You are now connected with ${request.counterpartDisplayName}.` : "");
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  if (requests.length === 0 && message === "") return null;

  return (
    <section className="record-form connection-requests-prompt" aria-label="Connection requests">
      {message.length > 0 ? (
        <p className="shell-note" role="status">
          {message}
        </p>
      ) : null}
      {requests.map((request) => (
        <article className="mini-card" key={request.id}>
          <strong>{request.counterpartDisplayName} wants to connect on Soko</strong>
          {request.counterpartBusinessName !== null ? (
            <small>{request.counterpartBusinessName}</small>
          ) : null}
          <div className="row-actions">
            <button
              type="button"
              disabled={busyId === request.id}
              onClick={() => void answer(request, true)}
            >
              Accept
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busyId === request.id}
              onClick={() => void answer(request, false)}
            >
              Decline
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
