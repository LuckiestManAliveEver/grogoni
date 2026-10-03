import { useEffect, useState } from "react";
import {
  formatKilogramsForDisplay,
  type ActivePoolsSummary,
  type AssignableDriverSummary,
  type CorridorPoolSummary,
  type CreateManifestResultSummary,
  type ManifestStopSummary,
  type ManifestSummary,
  type VehicleSummary
} from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { getJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { ApiRequestError } from "./lib/api";
import { formatMoney } from "./formatters";
import { fulfillmentCopy, formatDurationSeconds } from "./fulfillment-copy";

type DeliveryOutcome = "ARRIVED" | "DELIVERED" | "FAILED" | "SKIPPED";

const kg = (grams: string) => formatKilogramsForDisplay(grams, { maximumFractionDigits: 0 });

// Operations view for corridor fulfillment (Phase 1c): corridor pools with their readiness,
// manual manifest creation, and delivery recording. Mounted permanently inside LogisticsSurface
// beside DeliveryRoutesCard. All decisions (readiness, which orders fit, stop order) are the
// server's; this card only displays them and sends the dispatcher's explicit actions. Reaching
// the target load never creates a manifest on its own (A14) - a person presses the button.
export default function CorridorDispatchCard(props: { businessId: string }) {
  const t = fulfillmentCopy();
  const fulfillmentPath = `/businesses/${props.businessId}/fulfillment`;
  const mutationRevision = useApiMutationRevision(fulfillmentPath);
  const { isPending, runAction } = useAsyncActions();
  const [pools, setPools] = useState<ActivePoolsSummary | null>(null);
  const [vehicles, setVehicles] = useState<VehicleSummary[]>([]);
  const [manifests, setManifests] = useState<ManifestSummary[]>([]);
  const [vehicleByCorridor, setVehicleByCorridor] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [drivers, setDrivers] = useState<AssignableDriverSummary[]>([]);
  // Only dispatchers can load the assignable drivers; anyone else sees who is assigned, read-only.
  const [canAssign, setCanAssign] = useState(false);
  const [driversFailed, setDriversFailed] = useState(false);
  const [reload, setReload] = useState(0);
  // Roles that cannot see delivery pools (drivers, cashiers) get a 403: show nothing, not an error.
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getJson<ActivePoolsSummary>(`${fulfillmentPath}/pools`),
      getJson<VehicleSummary[]>(`${fulfillmentPath}/vehicles`).catch(() => []),
      getJson<ManifestSummary[]>(`${fulfillmentPath}/manifests`).catch(() => []),
      getJson<AssignableDriverSummary[]>(`${fulfillmentPath}/drivers`)
        .then((list) => ({ ok: true as const, forbidden: false, list }))
        .catch((error: unknown) => ({
          ok: false as const,
          // A 403 means this viewer cannot dispatch; anything else is a failure worth saying.
          forbidden: error instanceof ApiRequestError && error.status === 403,
          list: [] as AssignableDriverSummary[]
        }))
    ])
      .then(([loadedPools, loadedVehicles, loadedManifests, loadedDrivers]) => {
        if (cancelled) return;
        setPools(loadedPools);
        setDrivers(loadedDrivers.list);
        setCanAssign(loadedDrivers.ok);
        setDriversFailed(!loadedDrivers.ok && !loadedDrivers.forbidden);
        setVehicles(loadedVehicles.filter((vehicle) => vehicle.active));
        setManifests(loadedManifests);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 403) setForbidden(true);
        else setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [fulfillmentPath, mutationRevision, reload]);

  function replaceManifest(updated: ManifestSummary) {
    setManifests((current) => {
      const others = current.filter((item) => item.id !== updated.id);
      return [updated, ...others];
    });
  }

  async function createManifest(pool: CorridorPoolSummary) {
    const vehicleId = vehicleByCorridor[pool.corridorId] ?? vehicles[0]?.id;
    if (vehicleId === undefined) {
      setMessage(t.noVehicles);
      return;
    }
    const result = await postJson<CreateManifestResultSummary>(`${fulfillmentPath}/manifests`, {
      corridorId: pool.corridorId,
      vehicleId
    });
    replaceManifest(result.manifest);
    setMessage(
      t.created(
        result.allocatedInvoiceIds.length,
        result.skippedInvoiceIds.length,
        result.requiresPlanningInvoiceIds.length
      )
    );
  }

  async function closeManifest(manifest: ManifestSummary) {
    replaceManifest(
      await postJson<ManifestSummary>(`${fulfillmentPath}/manifests/${manifest.id}/close`, {})
    );
  }

  async function departManifest(manifest: ManifestSummary) {
    replaceManifest(
      await postJson<ManifestSummary>(`${fulfillmentPath}/manifests/${manifest.id}/depart`, {})
    );
  }

  async function assignDriver(manifest: ManifestSummary, driverUserId: string | null) {
    replaceManifest(
      await postJson<ManifestSummary>(`${fulfillmentPath}/manifests/${manifest.id}/driver`, {
        driverUserId
      })
    );
  }

  async function cancelManifest(manifest: ManifestSummary) {
    const reason = (notes[manifest.id] ?? "").trim();
    if (reason.length === 0) {
      setMessage(t.cancellationReasonRequired);
      return;
    }
    replaceManifest(
      await postJson<ManifestSummary>(`${fulfillmentPath}/manifests/${manifest.id}/cancel`, {
        reason
      })
    );
    setNotes((current) => ({ ...current, [manifest.id]: "" }));
  }

  async function removeStop(manifest: ManifestSummary, stop: ManifestStopSummary) {
    replaceManifest(
      await postJson<ManifestSummary>(
        `${fulfillmentPath}/manifests/${manifest.id}/orders/${stop.invoiceId}/remove`,
        {}
      )
    );
  }

  async function recordDelivery(
    manifest: ManifestSummary,
    stop: ManifestStopSummary,
    outcome: DeliveryOutcome
  ) {
    const note = (notes[stop.id] ?? "").trim();
    if ((outcome === "FAILED" || outcome === "SKIPPED") && note.length === 0) {
      setMessage(t.noteRequired);
      return;
    }
    replaceManifest(
      await postJson<ManifestSummary>(
        `${fulfillmentPath}/manifests/${manifest.id}/stops/${stop.id}/delivery`,
        note.length === 0 ? { outcome } : { outcome, note }
      )
    );
    setNotes((current) => ({ ...current, [stop.id]: "" }));
  }

  function act(key: string, action: () => Promise<void>) {
    void runAction(key, async () => {
      try {
        await action();
      } catch (error) {
        setMessage(getUserFacingErrorMessage(error));
      }
    });
  }

  const corridorName = (corridorId: string) =>
    pools?.pools.find((pool) => pool.corridorId === corridorId)?.corridorName ?? corridorId;
  const unassigned = pools?.unassigned;

  if (forbidden) return null;

  return (
    <section className="record-form corridor-dispatch-card" aria-label={t.dispatch}>
      <div className="section-heading">
        <p className="eyebrow">{t.dispatch}</p>
        <h3>{t.poolsHeading}</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {driversFailed ? (
        <div className="row-actions">
          <p className="shell-note" role="alert">
            {t.driversUnavailable}
          </p>
          <button className="secondary" type="button" onClick={() => setReload((n) => n + 1)}>
            {t.retry}
          </button>
        </div>
      ) : null}
      {pools === null ? (
        message.length > 0 ? null : (
          <p>{t.loading}</p>
        )
      ) : (
        <>
          {pools.pools.length === 0 ? <p className="shell-note">{t.noPools}</p> : null}
          {pools.pools.map((pool) => (
            <article className="mini-card corridor-pool" key={pool.corridorId}>
              <strong>
                {pool.corridorName} ·{" "}
                {pool.readiness === null ? t.noPolicy : t.readiness[pool.readiness]}
              </strong>
              <span>
                {kg(pool.eligibleTotalWeightGrams)}
                {pool.targetLoadGrams === null
                  ? ""
                  : ` ${t.ofTarget(kg(pool.targetLoadGrams))}`} ·{" "}
                {t.orders(pool.eligibleOrderCount)}
              </span>
              {pool.percentFilled !== null ? (
                <progress max={100} value={Math.min(100, pool.percentFilled)}>
                  {pool.percentFilled}%
                </progress>
              ) : null}
              {pool.staleResolutionCount > 0 ? (
                <small>{t.staleCount(pool.staleResolutionCount)}</small>
              ) : null}
              {pool.unresolvedWeightCount > 0 ? (
                <small>{t.unknownWeightCount(pool.unresolvedWeightCount)}</small>
              ) : null}
              {pool.timeUntilCutoffSeconds !== null ? (
                <small>{t.cutoffIn(formatDurationSeconds(pool.timeUntilCutoffSeconds))}</small>
              ) : null}
              {pool.oldestWaitingOrderAgeSeconds !== null ? (
                <small>
                  {t.oldestWaiting(formatDurationSeconds(pool.oldestWaitingOrderAgeSeconds))}
                </small>
              ) : null}
              {pool.eligibleOrderCount > 0 ? (
                <div className="row-actions">
                  {vehicles.length === 0 ? (
                    <small>{t.noVehicles}</small>
                  ) : (
                    <>
                      <select
                        aria-label={t.vehicle}
                        value={vehicleByCorridor[pool.corridorId] ?? vehicles[0]?.id ?? ""}
                        onChange={(event) =>
                          setVehicleByCorridor((current) => ({
                            ...current,
                            [pool.corridorId]: event.target.value
                          }))
                        }
                      >
                        {vehicles.map((vehicle) => (
                          <option key={vehicle.id} value={vehicle.id}>
                            {vehicle.name} · {kg(vehicle.capacityGrams)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={isPending(`manifest-create-${pool.corridorId}`)}
                        onClick={() =>
                          act(`manifest-create-${pool.corridorId}`, () => createManifest(pool))
                        }
                      >
                        {t.createManifest}
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </article>
          ))}
          {unassigned !== undefined &&
          unassigned.orderCount + unassigned.pendingIntakeCount + unassigned.orphanedCount > 0 ? (
            <article className="mini-card corridor-pool-unassigned">
              <strong>
                {t.unassigned} · {t.orders(unassigned.orderCount)}
              </strong>
              <small>
                {t.unassignedDetail(
                  unassigned.unresolvedLocationCount,
                  unassigned.noCorridorCount,
                  unassigned.pendingIntakeCount,
                  unassigned.orphanedCount
                )}
              </small>
            </article>
          ) : null}
        </>
      )}

      <div className="section-heading">
        <p className="eyebrow">{t.manifests}</p>
      </div>
      {manifests.length === 0 ? <p className="shell-note">{t.noManifests}</p> : null}
      {manifests.map((manifest) => {
        const activeStops = manifest.stops.filter((stop) => stop.allocationActive);
        const recording = manifest.status === "CLOSED" || manifest.status === "DEPARTED";
        return (
          <article className="mini-card manifest-card" key={manifest.id}>
            <strong>
              {corridorName(manifest.corridorId)} · {t.manifestStatus[manifest.status]}
            </strong>
            <span>
              {t.loadOf(kg(manifest.totalWeightGrams), kg(manifest.vehicleCapacityGrams))} ·{" "}
              {t.orders(activeStops.length)}
            </span>
            {!canAssign || manifest.status === "COMPLETED" || manifest.status === "CANCELLED" ? (
              <small>
                {t.driver}:{" "}
                {manifest.driverName ??
                  (manifest.driverUserId === null ? t.noDriver : t.driverLeft)}
              </small>
            ) : (
              <label>
                {t.assignDriver}
                <select
                  value={manifest.driverUserId ?? ""}
                  disabled={isPending(`manifest-driver-${manifest.id}`)}
                  onChange={(event) =>
                    act(`manifest-driver-${manifest.id}`, () =>
                      assignDriver(manifest, event.target.value === "" ? null : event.target.value)
                    )
                  }
                >
                  <option value="">{t.noDriver}</option>
                  {manifest.driverUserId !== null &&
                  !drivers.some((driver) => driver.userId === manifest.driverUserId) ? (
                    <option value={manifest.driverUserId}>
                      {manifest.driverName ?? t.driverLeft}
                    </option>
                  ) : null}
                  {drivers.map((driver) => (
                    <option key={driver.userId} value={driver.userId}>
                      {driver.displayName || driver.userId}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ol className="manifest-stops">
              {manifest.stops.map((stop) => (
                <li key={stop.id}>
                  <span>
                    {stop.sequence}. {stop.customerName ?? t.walkIn} · {kg(stop.orderWeightGrams)} ·{" "}
                    {stop.allocationActive ? t.stopStatus[stop.deliveryStatus] : t.released}
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
                  {stop.allocationActive ? (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${stop.latitude},${stop.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t.location}
                    </a>
                  ) : null}
                  {manifest.status === "OPEN" && stop.allocationActive ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={isPending(`manifest-remove-${stop.id}`)}
                      onClick={() =>
                        act(`manifest-remove-${stop.id}`, () => removeStop(manifest, stop))
                      }
                    >
                      {t.remove}
                    </button>
                  ) : null}
                  {recording &&
                  stop.allocationActive &&
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
                            disabled={isPending(`stop-${stop.id}`)}
                            onClick={() =>
                              act(`stop-${stop.id}`, () => recordDelivery(manifest, stop, outcome))
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
            {manifest.status === "OPEN" && activeStops.length > 0 ? (
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending(`manifest-close-${manifest.id}`)}
                  onClick={() =>
                    act(`manifest-close-${manifest.id}`, () => closeManifest(manifest))
                  }
                >
                  {t.close}
                </button>
              </div>
            ) : null}
            {manifest.status === "CLOSED" ? (
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending(`manifest-depart-${manifest.id}`)}
                  onClick={() =>
                    act(`manifest-depart-${manifest.id}`, () => departManifest(manifest))
                  }
                >
                  {t.depart}
                </button>
              </div>
            ) : null}
            {manifest.status === "OPEN" || manifest.status === "CLOSED" ? (
              <div className="row-actions">
                <input
                  aria-label={t.note}
                  placeholder={t.note}
                  value={notes[manifest.id] ?? ""}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [manifest.id]: event.target.value }))
                  }
                />
                <button
                  className="secondary"
                  type="button"
                  disabled={isPending(`manifest-cancel-${manifest.id}`)}
                  onClick={() =>
                    act(`manifest-cancel-${manifest.id}`, () => cancelManifest(manifest))
                  }
                >
                  {t.cancel}
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
