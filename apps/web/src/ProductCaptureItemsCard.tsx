import { useEffect, useState } from "react";
import type { ProductCaptureItemSummary, ProductCaptureJobSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { apiFetch } from "./lib/api";
import { invalidateApiCacheForMutation } from "./api-request-cache";
import { getUserFacingErrorMessage } from "./user-facing-error";
import StatusBroadcastComposer from "./StatusBroadcastComposer";

interface ItemDraft {
  title: string;
  category: string;
  description: string;
  visiblePrice: string;
}

function draftFromItem(item: ProductCaptureItemSummary): ItemDraft {
  return {
    title: item.fields.title.value ?? "",
    category: item.fields.category.value ?? "",
    description: item.fields.description.value ?? "",
    visiblePrice:
      item.fields.visiblePrice.value === null ? "" : String(item.fields.visiblePrice.value)
  };
}

export default function ProductCaptureItemsCard(props: {
  businessId: string;
  captureJobId: string;
  onPosted: (statusBroadcastId: string) => void;
}) {
  const { isPending, runAction } = useAsyncActions();
  const [job, setJob] = useState<ProductCaptureJobSummary | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void apiFetch<ProductCaptureJobSummary>(
      `/businesses/${props.businessId}/product-captures/${encodeURIComponent(props.captureJobId)}`
    )
      .then((loaded) => {
        if (cancelled) return;
        setJob(loaded);
        setDrafts(Object.fromEntries(loaded.items.map((item) => [item.id, draftFromItem(item)])));
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [props.businessId, props.captureJobId]);

  async function confirmItem(item: ProductCaptureItemSummary) {
    const draft = drafts[item.id] ?? draftFromItem(item);
    if (draft.title.trim().length === 0) {
      setMessage("Enter a name before confirming this item.");
      return;
    }
    const path = `/businesses/${props.businessId}/product-captures/${encodeURIComponent(
      props.captureJobId
    )}/items/${encodeURIComponent(item.id)}/confirm`;
    const result = await apiFetch<{ job: ProductCaptureJobSummary }>(path, {
      method: "POST",
      body: {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        visiblePrice: draft.visiblePrice.trim().length === 0 ? null : Number(draft.visiblePrice),
        unit: "unit"
      }
    });
    invalidateApiCacheForMutation(path);
    setJob(result.job);
  }

  async function rejectItem(item: ProductCaptureItemSummary) {
    const path = `/businesses/${props.businessId}/product-captures/${encodeURIComponent(
      props.captureJobId
    )}/items/${encodeURIComponent(item.id)}/reject`;
    const updated = await apiFetch<ProductCaptureJobSummary>(path, { method: "POST", body: {} });
    invalidateApiCacheForMutation(path);
    setJob(updated);
  }

  if (job === null) {
    return (
      <section className="record-form product-capture-card" aria-label="Photo capture">
        {message.length > 0 ? (
          <p className="shell-note">{message}</p>
        ) : (
          <p>Loading photo capture…</p>
        )}
      </section>
    );
  }

  const pendingItems = job.items.filter((item) => item.status === "pending_review");
  const confirmedCount = job.items.filter((item) => item.status === "confirmed").length;

  return (
    <section className="record-form product-capture-card" aria-label="Review photo capture items">
      <div className="section-heading">
        <p className="eyebrow">Sell from a photo</p>
        <h3>Review items from this photo</h3>
      </div>
      {job.detectionAvailable ? null : (
        <p className="shell-note" role="status">
          Detection isn't available yet — review each item manually before confirming.
        </p>
      )}
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {job.items.map((item) => {
        const draft = drafts[item.id] ?? draftFromItem(item);
        const resolved = item.status !== "pending_review";
        return (
          <div className="product-capture-item" key={item.id}>
            {item.boundingBox !== null ? (
              <div
                className="product-capture-item-pin"
                style={{
                  left: `${item.boundingBox.x * 100}%`,
                  top: `${item.boundingBox.y * 100}%`,
                  width: `${item.boundingBox.width * 100}%`,
                  height: `${item.boundingBox.height * 100}%`
                }}
              />
            ) : null}
            {resolved ? (
              <p className="shell-note">
                {item.status === "confirmed"
                  ? `Confirmed: ${draft.title}`
                  : `Rejected: ${draft.title}`}
              </p>
            ) : (
              <>
                <label>
                  Item name
                  <input
                    value={draft.title}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [item.id]: { ...draft, title: event.target.value }
                      }))
                    }
                  />
                </label>
                <label>
                  Selling price
                  <input
                    inputMode="decimal"
                    value={draft.visiblePrice}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [item.id]: { ...draft, visiblePrice: event.target.value }
                      }))
                    }
                  />
                </label>
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={isPending(`capture-item-confirm-${item.id}`)}
                    onClick={() =>
                      void runAction(`capture-item-confirm-${item.id}`, async () => {
                        try {
                          await confirmItem(item);
                        } catch (error) {
                          setMessage(getUserFacingErrorMessage(error));
                        }
                      })
                    }
                  >
                    Confirm item
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={isPending(`capture-item-reject-${item.id}`)}
                    onClick={() =>
                      void runAction(`capture-item-reject-${item.id}`, async () => {
                        try {
                          await rejectItem(item);
                        } catch (error) {
                          setMessage(getUserFacingErrorMessage(error));
                        }
                      })
                    }
                  >
                    Not a product
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {pendingItems.length === 0 && confirmedCount > 0 ? (
        <StatusBroadcastComposer
          businessId={props.businessId}
          captureJobId={props.captureJobId}
          onPosted={props.onPosted}
        />
      ) : null}
      {pendingItems.length === 0 && confirmedCount === 0 ? (
        <p className="shell-note">No items were confirmed from this photo.</p>
      ) : null}
    </section>
  );
}
