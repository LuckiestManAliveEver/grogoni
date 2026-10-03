import { useEffect, useState } from "react";
import type { CorridorMatchResultSummary, ShopLocationStatusSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { getJson, putJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { fulfillmentCopy } from "./fulfillment-copy";

// Field-sales delivery-point capture for one shop (a business's customer). The salesperson stands
// at the shop and taps once: the browser's GPS fix and its reported accuracy are sent as-is, and
// the server decides the corridor. Mounted inside CustomerSurface while a customer is open for
// editing. Coordinates are shown only when the server returns them (shop_location:read_precise).
export default function ShopLocationCard(props: { businessId: string; customerId: string }) {
  const t = fulfillmentCopy();
  const shopPath = `/businesses/${props.businessId}/fulfillment/shops/${props.customerId}`;
  const mutationRevision = useApiMutationRevision(shopPath);
  const { isPending, runAction } = useAsyncActions();
  const [location, setLocation] = useState<ShopLocationStatusSummary | null>(null);
  const [match, setMatch] = useState<CorridorMatchResultSummary | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getJson<ShopLocationStatusSummary>(`${shopPath}/location`),
      getJson<CorridorMatchResultSummary>(`${shopPath}/corridor-match`).catch(() => null)
    ])
      .then(([loadedLocation, loadedMatch]) => {
        if (cancelled) return;
        setLocation(loadedLocation);
        setMatch(loadedMatch);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [shopPath, mutationRevision]);

  function currentPosition(): Promise<GeolocationPosition> {
    return new Promise((resolvePosition, reject) => {
      if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
        reject(new Error(t.geolocationUnavailable));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        resolvePosition,
        (error) => {
          reject(
            new Error(error.code === error.PERMISSION_DENIED ? t.geolocationDenied : error.message)
          );
        },
        { enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 }
      );
    });
  }

  async function capture() {
    setMessage(t.capturing);
    const position = await currentPosition();
    const saved = await putJson<ShopLocationStatusSummary>(`${shopPath}/location`, {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null
    });
    setLocation(saved);
    setMatch(
      await getJson<CorridorMatchResultSummary>(`${shopPath}/corridor-match`).catch(() => null)
    );
    setMessage(t.savedLocation);
  }

  const current = location?.current ?? null;

  return (
    <section className="record-form shop-location-card" aria-label={t.shopLocation}>
      <div className="section-heading">
        <p className="eyebrow">{t.shopLocation}</p>
        <h3>{t.captureHeading}</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {location === null ? (
        <p>{t.loading}</p>
      ) : current === null ? (
        <p className="shell-note">{t.noLocation}</p>
      ) : (
        <article className="mini-card">
          <strong>{t.locationCaptured}</strong>
          {current.latitude !== null && current.longitude !== null ? (
            <span>
              {current.latitude.toFixed(5)}, {current.longitude.toFixed(5)}
            </span>
          ) : null}
          {current.accuracyMeters !== null ? (
            <small>{t.accuracy(current.accuracyMeters)}</small>
          ) : null}
          <small>{new Date(current.capturedAt).toLocaleString()}</small>
        </article>
      )}
      {match !== null ? (
        <p className="shell-note">
          {t.corridor}:{" "}
          {match.status === "RESOLVED"
            ? t.onCorridor(match.selected.corridorName, match.selected.diversionMeters)
            : t.noCorridor}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          disabled={isPending("shop-location-capture")}
          onClick={() =>
            void runAction("shop-location-capture", async () => {
              try {
                await capture();
              } catch (error) {
                setMessage(getUserFacingErrorMessage(error));
              }
            })
          }
        >
          {current === null ? t.capture : t.recapture}
        </button>
      </div>
    </section>
  );
}
