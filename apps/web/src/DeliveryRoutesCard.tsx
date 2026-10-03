import { useEffect, useState } from "react";
import type { DeliveryRouteStatus, DeliveryRouteSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { getJson, patchJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";

interface RouteDraft {
  originLabel: string;
  originAddress: string;
  destinationLabel: string;
  destinationAddress: string;
  provider: string;
}

const emptyDraft: RouteDraft = {
  originLabel: "",
  originAddress: "",
  destinationLabel: "",
  destinationAddress: "",
  provider: ""
};

const routeStatuses: DeliveryRouteStatus[] = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

// Self-contained management card for the commercial-records domain's provider-neutral delivery
// routes. Mounted permanently inside LogisticsSurface, not chat-invoked - a full route/stop
// ledger has no natural free-text phrasing to route through the runtime-tool system (same
// reasoning as this session's own scoping decision on purchases/sales - see
// docs/frontend/frontend.md's Phase 4h precedent for the neighboring logistics-status capability
// that *did* get a chat trigger, and Phase 4i/4j's "no card, no bug" verdicts for domains that
// don't). Fetches its own data from businessId alone, same shape as
// LogisticsManagementCard/PurchaseSaleRecordsCard.
//
// DeliveryRouteSummary only carries origin/destination *location ids*, not labels - there is no
// GET /locations endpoint to resolve one later. Labels typed into this card's own create form are
// cached locally (locationLabels) so routes created in this session show a readable place name;
// routes created elsewhere fall back to showing the raw location id rather than inventing a label.
export default function DeliveryRoutesCard(props: { businessId: string }) {
  const routesPath = `/businesses/${props.businessId}/routes`;
  const mutationRevision = useApiMutationRevision(routesPath);
  const { isPending, runAction } = useAsyncActions();

  const [routes, setRoutes] = useState<DeliveryRouteSummary[] | null>(null);
  const [locationLabels, setLocationLabels] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState<RouteDraft>(emptyDraft);
  const [statusDrafts, setStatusDrafts] = useState<Record<string, DeliveryRouteStatus>>({});

  useEffect(() => {
    let cancelled = false;
    void getJson<DeliveryRouteSummary[]>(`${routesPath}/history`)
      .then((loaded) => {
        if (cancelled) return;
        setRoutes(loaded);
        setStatusDrafts(Object.fromEntries(loaded.map((route) => [route.id, route.status])));
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [routesPath, mutationRevision]);

  function locationLabel(locationId: string): string {
    return locationLabels[locationId] ?? locationId;
  }

  async function createRoute() {
    if (draft.originLabel.trim().length === 0 || draft.destinationLabel.trim().length === 0) {
      setMessage("Enter both an origin and a destination.");
      return;
    }
    const created = await postJson<DeliveryRouteSummary>(routesPath, {
      origin: { label: draft.originLabel.trim(), address: draft.originAddress.trim() || null },
      destination: {
        label: draft.destinationLabel.trim(),
        address: draft.destinationAddress.trim() || null
      },
      provider: draft.provider.trim() || undefined
    });
    setLocationLabels((current) => ({
      ...current,
      [created.originLocationId]: draft.originLabel.trim(),
      [created.destinationLocationId]: draft.destinationLabel.trim()
    }));
    setRoutes((current) => [created, ...(current ?? [])]);
    setStatusDrafts((current) => ({ ...current, [created.id]: created.status }));
    setDraft(emptyDraft);
    setMessage(`Route to ${draft.destinationLabel.trim()} created`);
  }

  async function updateStatus(route: DeliveryRouteSummary) {
    const status = statusDrafts[route.id] ?? route.status;
    const updated = await patchJson<DeliveryRouteSummary>(`${routesPath}/${route.id}`, { status });
    setRoutes((current) =>
      (current ?? []).map((item) => (item.id === updated.id ? updated : item))
    );
    setMessage(`Route status set to ${updated.status.replace(/_/g, " ").toLowerCase()}`);
  }

  return (
    <section className="record-form delivery-routes-card" aria-label="Delivery routes">
      <div className="section-heading">
        <p className="eyebrow">Delivery routes</p>
        <h3>Plan a route</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}

      <div className="form-row">
        <label>
          Origin
          <input
            value={draft.originLabel}
            placeholder="Origin place name"
            onChange={(event) =>
              setDraft((current) => ({ ...current, originLabel: event.target.value }))
            }
          />
        </label>
        <label>
          Origin address
          <input
            value={draft.originAddress}
            placeholder="Optional"
            onChange={(event) =>
              setDraft((current) => ({ ...current, originAddress: event.target.value }))
            }
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          Destination
          <input
            value={draft.destinationLabel}
            placeholder="Destination place name"
            onChange={(event) =>
              setDraft((current) => ({ ...current, destinationLabel: event.target.value }))
            }
          />
        </label>
        <label>
          Destination address
          <input
            value={draft.destinationAddress}
            placeholder="Optional"
            onChange={(event) =>
              setDraft((current) => ({ ...current, destinationAddress: event.target.value }))
            }
          />
        </label>
      </div>
      <label>
        Provider
        <input
          value={draft.provider}
          placeholder="Defaults to manual"
          onChange={(event) =>
            setDraft((current) => ({ ...current, provider: event.target.value }))
          }
        />
      </label>
      <div className="row-actions">
        <button
          type="button"
          disabled={isPending("route-record-save")}
          onClick={() =>
            void runAction("route-record-save", async () => {
              try {
                await createRoute();
              } catch (error) {
                setMessage(getUserFacingErrorMessage(error));
              }
            })
          }
        >
          Save route
        </button>
      </div>

      <div className="section-heading">
        <p className="eyebrow">History</p>
        <h4>Routes</h4>
      </div>
      {routes === null ? (
        <p>Loading routes…</p>
      ) : routes.length === 0 ? (
        <p className="shell-note">No routes recorded yet.</p>
      ) : (
        routes.map((route) => (
          <article className="mini-card" key={route.id}>
            <strong>
              {locationLabel(route.originLocationId)} → {locationLabel(route.destinationLocationId)}
            </strong>
            <span>
              {route.provider} · {route.status.replace(/_/g, " ").toLowerCase()}
            </span>
            {route.distanceMeters !== null ? (
              <small>{Math.round(route.distanceMeters / 1000)} km</small>
            ) : null}
            <small>{new Date(route.createdAt).toLocaleDateString()}</small>
            <div className="row-actions">
              <select
                value={statusDrafts[route.id] ?? route.status}
                onChange={(event) =>
                  setStatusDrafts((current) => ({
                    ...current,
                    [route.id]: event.target.value as DeliveryRouteStatus
                  }))
                }
              >
                {routeStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
              <button
                className="secondary"
                type="button"
                disabled={
                  isPending(`route-status-${route.id}`) ||
                  (statusDrafts[route.id] ?? route.status) === route.status
                }
                onClick={() =>
                  void runAction(`route-status-${route.id}`, async () => {
                    try {
                      await updateStatus(route);
                    } catch (error) {
                      setMessage(getUserFacingErrorMessage(error));
                    }
                  })
                }
              >
                Update status
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
