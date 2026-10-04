import { useEffect, useState } from "react";
import type {
  StatusBroadcastCandidateSummary,
  StatusBroadcastSummary
} from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { apiFetch } from "./lib/api";
import { invalidateApiCacheForMutation } from "./api-request-cache";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { shareMessageExternally } from "./messaging/platform-handoff";

export default function StatusBroadcastComposer(props: {
  businessId: string;
  captureJobId: string;
  onPosted: (statusBroadcastId: string) => void;
}) {
  const { isPending, runAction } = useAsyncActions();
  const [candidates, setCandidates] = useState<StatusBroadcastCandidateSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [posted, setPosted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ candidates: StatusBroadcastCandidateSummary[] }>(
      `/businesses/${props.businessId}/status-broadcasts/candidates`
    )
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        // Never default to select-all: only pre-check contacts who are both a matched Grogoni
        // account and an existing customer of this business.
        setSelected(
          new Set(
            result.candidates
              .filter((candidate) => candidate.defaultSelected)
              .map((candidate) => candidate.networkNodeId)
          )
        );
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [props.businessId]);

  async function post() {
    if (selected.size === 0) {
      setMessage("Choose at least one contact.");
      return;
    }
    const path = `/businesses/${props.businessId}/status-broadcasts`;
    const status = await apiFetch<StatusBroadcastSummary>(path, {
      method: "POST",
      body: {
        sourceCaptureJobId: props.captureJobId,
        recipientNodeIds: [...selected]
      }
    });
    invalidateApiCacheForMutation(path);

    const shareRecipients = status.recipients.filter(
      (recipient) => recipient.deliveryChannel === "share_sheet_pending"
    );
    if (shareRecipients.length > 0) {
      const itemsText = status.items.map((item) => item.title).join(", ");
      await shareMessageExternally({ text: `Check out what I'm selling: ${itemsText}` });
    }

    setPosted(true);
    props.onPosted(status.id);
  }

  if (posted) return null;

  if (candidates === null) {
    return (
      <div className="record-form">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading contacts…</p>}
      </div>
    );
  }

  return (
    <div className="record-form status-broadcast-composer" aria-label="Post status to contacts">
      <div className="section-heading">
        <p className="eyebrow">Post as a status</p>
        <h3>Choose who sees this</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {candidates.length === 0 ? (
        <p className="shell-note">No phone contacts are synced yet.</p>
      ) : (
        candidates.map((candidate) => (
          <label className="checkbox-row" key={candidate.networkNodeId}>
            <input
              type="checkbox"
              checked={selected.has(candidate.networkNodeId)}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(candidate.networkNodeId);
                  else next.delete(candidate.networkNodeId);
                  return next;
                })
              }
            />
            <span className="status-contact-avatar" aria-hidden="true">
              {candidate.displayName.trim().slice(0, 1).toUpperCase()}
            </span>
            <span className="status-contact-copy">
              <strong>{candidate.displayName}</strong>
              <small>{candidate.isGrogoniUser ? "On Grogoni" : "Shared via your phone"}</small>
            </span>
          </label>
        ))
      )}
      <div className="row-actions">
        <button
          type="button"
          disabled={isPending("status-broadcast-post") || selected.size === 0}
          onClick={() =>
            void runAction("status-broadcast-post", async () => {
              try {
                await post();
              } catch (error) {
                setMessage(getUserFacingErrorMessage(error));
              }
            })
          }
        >
          {isPending("status-broadcast-post") ? "Posting…" : `Post to ${selected.size} contacts`}
        </button>
      </div>
    </div>
  );
}
