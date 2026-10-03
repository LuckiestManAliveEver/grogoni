import { useEffect, useState } from "react";
import type { StatusBroadcastSummary } from "@grogoni/shared-types";
import { apiFetch } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";

const pollIntervalMs = 15000;

export default function StatusBroadcastCard(props: {
  businessId: string;
  statusBroadcastId: string;
}) {
  const [status, setStatus] = useState<StatusBroadcastSummary | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        const loaded = await apiFetch<StatusBroadcastSummary>(
          `/businesses/${props.businessId}/status-broadcasts/${encodeURIComponent(
            props.statusBroadcastId
          )}`
        );
        if (cancelled) return;
        setStatus(loaded);
        if (loaded.state === "active") {
          timer = setTimeout(() => void load(), pollIntervalMs);
        }
      } catch (error) {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [props.businessId, props.statusBroadcastId]);

  if (status === null) {
    return (
      <section className="record-form status-broadcast-card" aria-label="Status">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading status…</p>}
      </section>
    );
  }

  const inAppCount = status.recipients.filter(
    (recipient) => recipient.deliveryChannel === "in_app"
  ).length;
  const shareCount = status.recipients.length - inAppCount;

  return (
    <section className="record-form status-broadcast-card" aria-label="Posted status">
      <div className="section-heading">
        <p className="eyebrow">Status posted</p>
        <h3>{status.items.map((item) => item.title).join(", ")}</h3>
      </div>
      <p>
        Posted to {status.recipients.length} contact{status.recipients.length === 1 ? "" : "s"} (
        {inAppCount} in-app, {shareCount} via share)
      </p>
      <div className="status-broadcast-counters">
        <span>{status.viewCount} views</span>
        <span>{status.replyCount} replies</span>
        <span>{status.resultingOrderIds.length} orders</span>
      </div>
    </section>
  );
}
