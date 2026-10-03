import { useEffect, useState } from "react";
import {
  formatKilogramsForDisplay,
  type ManifestStopSummary,
  type ManifestSummary
} from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { fetchFreshJson, postJson } from "./api-helpers";
import { ApiRequestError } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { formatMoney } from "./formatters";
import { fulfillmentCopy } from "./fulfillment-copy";

type DeliveryOutcome = "ARRIVED" | "DELIVERED" | "FAILED" | "SKIPPED";

const kg = (grams: string) => formatKilogramsForDisplay(grams, { maximumFractionDigits: 0 });

// "My deliveries" for the signed-in member (docs/architecture/corridor-fulfillment.md §16): only
// the trips a dispatcher assigned to them, with stops in road order, a map link per stop, Start
// route, and delivery outcomes. The server scopes everything to the assignment; this card only
// shows what it returns. Roles that cannot record deliveries get a 403 and see nothing; a driver
// with no trips sees an empty state, anyone else sees nothing.
export default function DriverManifestsCard(props: {
  businessId: string;
  /** Show "No deliveries assigned" when empty (members who deliver but do not dispatch). */
  showEmptyState: boolean;
}) {
  const t = fulfillmentCopy();
  const path = `/businesses/${props.businessId}/fulfillment`;
  const revision = useApiMutationRevision(path);
  const { isPending, runAction } = useAsyncActions();
  const [manifests, setManifests] = useState<ManifestSummary[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchFreshJson<ManifestSummary[]>(`${path}/my-manifests`)
      .then((loaded) => {
        if (!cancelled) setManifests(loaded);
      })
      .catch((error) => {
        if (cancelled) return;
        // A role that cannot record deliveries has no trips; losing membership is said out loud.
        if (
          error instanceof ApiRequestError &&
          error.status === 403 &&
          error.code === "permission_denied"
        ) {
          setManifests([]);
        } else setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [path, revision]);

  function act(key: string, action: () => Promise<void>) {
    setMessage("");
    void runAction(key, async () => {
      try {
        await action();
      } catch (error) {
        setMessage(getUserFacingErrorMessage(error));
      }
    });
  }

  function replace(updated: ManifestSummary) {
    setManifests((current) =>
      (current ?? []).map((item) => (item.id === updated.id ? updated : item))
    );
  }

  async function depart(manifest: ManifestSummary) {
    replace(await postJson<ManifestSummary>(`${path}/manifests/${manifest.id}/depart`, {}));
  }

  async function record(
    manifest: ManifestSummary,
    stop: ManifestStopSummary,
    outcome: DeliveryOutcome
  ) {
    const note = (notes[stop.id] ?? "").trim();
    if ((outcome === "FAILED" || outcome === "SKIPPED") && note.length === 0) {
      setMessage(t.noteRequired);
      return;
    }
    replace(
      await postJson<ManifestSummary>(
        `${path}/manifests/${manifest.id}/stops/${stop.id}/delivery`,
        note.length === 0 ? { outcome } : { outcome, note }
      )
    );
    setNotes((current) => ({ ...current, [stop.id]: "" }));
  }

  if (manifests === null && message === "") return null;
  if (manifests !== null && manifests.length === 0 && !props.showEmptyState) return null;

  return (
    <section className="record-form driver-manifests-card" aria-label={t.myDeliveries}>
      <div className="section-heading">
        <p className="eyebrow">{t.myDeliveries}</p>
      </div>
      {message.length > 0 ? (
        <p className="shell-note" role="alert">
          {message}
        </p>
      ) : null}
      {manifests !== null && manifests.length === 0 ? (
        <p className="shell-note">{t.noAssignedTrips}</p>
      ) : null}
      {(manifests ?? []).map((manifest) => {
        const stops = manifest.stops.filter((stop) => stop.allocationActive);
        const recording = manifest.status === "CLOSED" || manifest.status === "DEPARTED";
        return (
          <article className="mini-card manifest-card" key={manifest.id}>
            <strong>
              {t.manifestStatus[manifest.status]} · {t.stopsCount(stops.length)} ·{" "}
              {kg(manifest.totalWeightGrams)}
            </strong>
            <ol className="manifest-stops">
              {stops.map((stop) => (
                <li key={stop.id}>
                  <span>
                    {stop.sequence}. {stop.customerName ?? t.walkIn} · {kg(stop.orderWeightGrams)} ·{" "}
                    {t.stopStatus[stop.deliveryStatus]}
                  </span>
                  {stop.items.length > 0 ? (
                    <small>
                      {t.items}:{" "}
                      {stop.items
                        .map((item) => `${item.quantity} x ${item.productName}`)
                        .join(", ")}
                    </small>
                  ) : null}
                  {stop.payOnDeliveryAmount !== null ? (
                    <strong>
                      {t.payOnDelivery}: {formatMoney(stop.payOnDeliveryAmount)}
                    </strong>
                  ) : null}
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${stop.latitude},${stop.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t.location}
                  </a>
                  {recording &&
                  (stop.deliveryStatus === "PENDING" || stop.deliveryStatus === "ARRIVED") ? (
                    <div className="row-actions">
                      <input
                        aria-label={t.note}
                        placeholder={t.note}
                        value={notes[stop.id] ?? ""}
                        onChange={(event) =>
                          setNotes((current) => ({ ...current, [stop.id]: event.target.value }))
                        }
                      />
                      {(
                        [
                          ["ARRIVED", t.arrived],
                          ["DELIVERED", t.delivered],
                          ["FAILED", t.failed],
                          ["SKIPPED", t.skipped]
                        ] as const
                      )
                        .filter(
                          ([outcome]) => outcome !== "ARRIVED" || stop.deliveryStatus === "PENDING"
                        )
                        .map(([outcome, label]) => (
                          <button
                            key={outcome}
                            className={outcome === "DELIVERED" ? "" : "secondary"}
                            type="button"
                            disabled={isPending(`driver-stop-${stop.id}`)}
                            onClick={() =>
                              act(`driver-stop-${stop.id}`, () => record(manifest, stop, outcome))
                            }
                          >
                            {label}
                          </button>
                        ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
            {manifest.status === "CLOSED" ? (
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending(`driver-depart-${manifest.id}`)}
                  onClick={() => act(`driver-depart-${manifest.id}`, () => depart(manifest))}
                >
                  {t.depart}
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
