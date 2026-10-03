import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  GramsFormatError,
  formatKilogramsForDisplay,
  parseKilogramsInput,
  type CorridorSummary,
  type DispatchFallbackAction,
  type DispatchPolicySummary,
  type FulfillmentSettingsSummary,
  type VehicleSummary
} from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { fetchFreshJson, patchJson, postJson } from "./api-helpers";
import { ApiRequestError } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { fulfillmentCopy } from "./fulfillment-copy";
import { appendRoutePoint, parseRoutePoints } from "./corridor-route-input";

// Self-serve corridor-delivery setup for whichever business is open (docs/architecture/
// corridor-fulfillment.md, §15.1). Every value here is the business's own data - its timezone,
// dispatch rules, vehicles and roads - entered by its owner. Nothing is pre-filled from code: an
// empty business shows empty forms with examples only as placeholders. The server decides who may
// change setup (`viewerCanManage`), validates every change, and converts nothing: kg typed here
// become exact gram strings through the shared parser before they are sent (A22).

const fallbackActions: DispatchFallbackAction[] = [
  "TRY_SMALLER_VEHICLE",
  "TRY_COMPATIBLE_CORRIDOR",
  "REQUIRE_DISPATCH_APPROVAL"
];

interface PolicyForm {
  name: string;
  targetKg: string;
  minimumKg: string;
  maxDiversionMeters: string;
  cutoffLocalTime: string;
  maxWaitHours: string;
  fulfillmentLeadDays: string;
  underThresholdFallback: DispatchFallbackAction[];
}

const emptyPolicy: PolicyForm = {
  name: "",
  targetKg: "",
  minimumKg: "",
  maxDiversionMeters: "",
  cutoffLocalTime: "",
  maxWaitHours: "",
  fulfillmentLeadDays: "",
  underThresholdFallback: []
};

type CreateSlot = "policy" | "vehicle" | "corridor";

const kgText = (grams: string) =>
  formatKilogramsForDisplay(grams, { maximumFractionDigits: 3 })
    .replace(/ kg$/u, "")
    .replace(/,/gu, "");

function policyForm(policy: DispatchPolicySummary): PolicyForm {
  return {
    name: policy.name,
    targetKg: kgText(policy.targetLoadGrams),
    minimumKg:
      policy.minimumDispatchLoadGrams === null ? "" : kgText(policy.minimumDispatchLoadGrams),
    maxDiversionMeters: String(policy.maxDiversionMeters),
    cutoffLocalTime: policy.cutoffLocalTime,
    maxWaitHours: String(policy.maxWaitHours),
    fulfillmentLeadDays: String(policy.fulfillmentLeadDays),
    underThresholdFallback: policy.underThresholdFallback
  };
}

function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function knownTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

const newKey = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Live "= 6,000 kg" under a kilogram field, so the owner sees exactly what will be saved. */
function KgEcho(props: { id: string; value: string; format: (text: string) => string }) {
  if (props.value.trim() === "") return null;
  let text: string;
  try {
    text = props.format(formatKilogramsForDisplay(parseKilogramsInput(props.value)));
  } catch {
    return null;
  }
  return (
    <small id={props.id} aria-live="polite">
      {text}
    </small>
  );
}

function Hint(props: { id: string; children: ReactNode }) {
  return <small id={props.id}>{props.children}</small>;
}

// Keyed by business: switching the open business starts from that business's saved state, so an
// unsaved draft for one business can never be submitted into another.
export default function FulfillmentSetupCard(props: { businessId: string }) {
  return <SetupForBusiness key={props.businessId} businessId={props.businessId} />;
}

function SetupForBusiness(props: { businessId: string }) {
  const t = fulfillmentCopy();
  const path = `/businesses/${props.businessId}/fulfillment`;
  const mutationRevision = useApiMutationRevision(path);
  const { isPending, runAction } = useAsyncActions();
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Roles without fulfillment:read (cashier, driver, view-only) have no setup to see at all.
  const [forbidden, setForbidden] = useState(false);
  const [settings, setSettings] = useState<FulfillmentSettingsSummary | null>(null);
  const [policy, setPolicy] = useState<DispatchPolicySummary | null>(null);
  const [vehicles, setVehicles] = useState<VehicleSummary[]>([]);
  const [corridors, setCorridors] = useState<CorridorSummary[]>([]);
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);

  const [timezone, setTimezoneValue] = useState("");
  const [policyDraft, setPolicyDraftValue] = useState<PolicyForm>(emptyPolicy);
  const [vehicleDraft, setVehicleDraft] = useState({ name: "", registration: "", capacityKg: "" });
  const [corridorDraft, setCorridorDraft] = useState({
    name: "",
    originLabel: "",
    destinationLabel: "",
    points: ""
  });

  // Anything on this page (a manifest, a vehicle) refreshes the card through mutationRevision.
  // A refresh must never overwrite what the owner is typing, so a field the owner has edited is
  // "dirty" and only a successful save of it clears that.
  const timezoneDirty = useRef(false);
  const policyDirty = useRef(false);
  // What each draft was based on, captured while it was still clean. Saves send it as
  // expectedTimezone / expectedVersion, so a change someone else made in the meantime (the owner
  // in another tab, an agent over MCP) is refused with 409 instead of silently overwritten.
  const timezoneBase = useRef<string | null>(null);
  // The policy draft is based on a specific lineage and version (null = no default existed).
  const policyBase = useRef<{ policyId: string; version: number } | null>(null);
  // After a conflict the card reloads the newer values; editing is locked until they arrive, so
  // nothing typed in between is based on the stale values the conflict just rejected.
  const [reloading, setReloading] = useState(false);
  // Set while the reload after a conflict is outstanding: if that reload fails, the form must stay
  // locked (it still shows the rejected draft) and the conflict must stay explained.
  const conflictReload = useRef(false);
  const loadedOnce = useRef(false);
  const setTimezone = (value: string) => {
    timezoneDirty.current = true;
    setTimezoneValue(value);
  };
  const setPolicyDraft = (value: PolicyForm) => {
    policyDirty.current = true;
    setPolicyDraftValue(value);
  };

  // A23: one idempotency key per payload. Resubmitting the same payload after a dropped response
  // or a double tap reuses the key (the server replays the first result); editing the payload
  // gets a fresh key, so a changed form can never collide with the old one.
  const pendingKeys = useRef<Partial<Record<CreateSlot, { payload: string; key: string }>>>({});
  function keyFor(slot: CreateSlot, body: unknown): string {
    const payload = JSON.stringify(body);
    const pending = pendingKeys.current[slot];
    if (pending !== undefined && pending.payload === payload) return pending.key;
    const key = newKey();
    pendingKeys.current[slot] = { payload, key };
    return key;
  }

  const device = useMemo(deviceTimezone, []);
  const zones = useMemo(knownTimezones, []);

  useEffect(() => {
    let cancelled = false;
    // Uncached: this card edits what it shows, so it must never start from a stale copy.
    void Promise.all([
      fetchFreshJson<FulfillmentSettingsSummary>(`${path}/settings`),
      fetchFreshJson<{ policy: DispatchPolicySummary | null }>(`${path}/default-policy`),
      fetchFreshJson<VehicleSummary[]>(`${path}/vehicles?include=inactive`),
      fetchFreshJson<CorridorSummary[]>(`${path}/corridors?include=inactive`)
    ])
      .then(([loadedSettings, loadedPolicy, loadedVehicles, loadedCorridors]) => {
        if (cancelled) return;
        setSettings(loadedSettings);
        if (!timezoneDirty.current) {
          timezoneBase.current = loadedSettings.timezone;
          setTimezoneValue(loadedSettings.timezone ?? "");
        }
        setPolicy(loadedPolicy.policy);
        if (!policyDirty.current) {
          policyBase.current =
            loadedPolicy.policy === null
              ? null
              : { policyId: loadedPolicy.policy.policyId, version: loadedPolicy.policy.version };
          setPolicyDraftValue(
            loadedPolicy.policy === null ? emptyPolicy : policyForm(loadedPolicy.policy)
          );
        }
        setVehicles(loadedVehicles);
        setCorridors(loadedCorridors);
        setLoadError(null);
        conflictReload.current = false;
        setReloading(false);
        // A successful refresh clears an earlier "could not refresh" warning.
        setNotice((current) => (current?.text === t.refreshFailed ? null : current));
        loadedOnce.current = true;
        setLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        if (conflictReload.current) {
          setNotice({ kind: "error", text: `${t.changedSinceOpened} ${t.refreshFailed}` });
          return;
        }
        setReloading(false);
        if (error instanceof ApiRequestError && error.status === 403) setForbidden(true);
        else if (loadedOnce.current) {
          // The card keeps showing what it had; say plainly that it may be out of date.
          setNotice({ kind: "error", text: t.refreshFailed });
        } else setLoadError(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [path, mutationRevision, reload]);

  function act(key: string, action: () => Promise<void>, slot?: CreateSlot) {
    setNotice(null);
    void runAction(key, async () => {
      try {
        await action();
      } catch (error) {
        if (
          error instanceof ApiRequestError &&
          (error.code === "dispatch_policy_version_conflict" ||
            error.code === "default_policy_changed" ||
            error.code === "timezone_changed")
        ) {
          // Someone else saved first: show their values (dropping this stale draft) and say so.
          if (error.code === "timezone_changed") timezoneDirty.current = false;
          else {
            policyDirty.current = false;
            delete pendingKeys.current.policy;
          }
          conflictReload.current = true;
          setReloading(true);
          setReload((current) => current + 1);
          setNotice({ kind: "error", text: t.changedSinceOpened });
          return;
        }
        if (
          slot !== undefined &&
          error instanceof ApiRequestError &&
          error.code === "idempotency_key_reused"
        ) {
          delete pendingKeys.current[slot];
          setReload((current) => current + 1);
          setNotice({ kind: "error", text: t.changedElsewhere });
          return;
        }
        setNotice({ kind: "error", text: getUserFacingErrorMessage(error) });
      }
    });
  }

  function kilograms(value: string, field: string, optional = false): string | null {
    if (value.trim() === "") {
      if (optional) return null;
      throw new Error(t.required(field));
    }
    try {
      return parseKilogramsInput(value, field);
    } catch (error) {
      if (error instanceof GramsFormatError) throw new Error(t.invalidKg(field));
      throw error;
    }
  }

  function requiredText(value: string, field: string): string {
    if (value.trim() === "") throw new Error(t.required(field));
    return value.trim();
  }

  function wholeNumber(value: string, field: string): number {
    if (value.trim() === "") throw new Error(t.required(field));
    if (!/^\d+$/u.test(value.trim())) throw new Error(t.wholeNumber(field));
    return Number(value.trim());
  }

  async function saveTimezone() {
    const saved = await patchJson<FulfillmentSettingsSummary>(`${path}/settings`, {
      timezone: timezone.trim() === "" ? null : timezone.trim(),
      expectedTimezone: timezoneBase.current
    });
    timezoneDirty.current = false;
    timezoneBase.current = saved.timezone;
    setSettings(saved);
    setTimezoneValue(saved.timezone ?? "");
    setNotice({ kind: "status", text: t.saved });
  }

  async function savePolicy() {
    // Validated in the order the fields appear, so the first message names the first problem.
    const body = {
      name: requiredText(policyDraft.name, t.policyName),
      targetLoadGrams: kilograms(policyDraft.targetKg, t.targetLoad),
      minimumDispatchLoadGrams: kilograms(policyDraft.minimumKg, t.minimumLoad, true),
      maxDiversionMeters: wholeNumber(policyDraft.maxDiversionMeters, t.maxDiversion),
      cutoffLocalTime: requiredText(policyDraft.cutoffLocalTime, t.cutoff),
      maxWaitHours: wholeNumber(policyDraft.maxWaitHours, t.maxWait),
      fulfillmentLeadDays: wholeNumber(policyDraft.fulfillmentLeadDays, t.leadDays),
      underThresholdFallback: fallbackActions.filter((action) =>
        policyDraft.underThresholdFallback.includes(action)
      ),
      overflowStrategy: "NEXT_MANIFEST"
    };
    // The draft says what it was based on; the server refuses (409) if either the default policy
    // or its version has moved since, so a stale draft can never replace newer rules. A first
    // create whose response was lost keeps its null base and payload, so its retry reuses the key
    // and the server replays it even if a refresh has since shown the policy it made.
    const base = policyBase.current;
    let saved: DispatchPolicySummary;
    if (base === null) {
      const create = { ...body, makeBusinessDefault: true, expectedDefaultPolicyId: null };
      saved = await postJson<DispatchPolicySummary>(`${path}/policies`, create, {
        idempotencyKey: keyFor("policy", ["create", create])
      });
    } else {
      const revision = {
        ...body,
        expectedVersion: base.version,
        expectedDefaultPolicyId: base.policyId
      };
      saved = await postJson<DispatchPolicySummary>(
        `${path}/policies/${base.policyId}/revisions`,
        revision,
        // Keyed on the lineage and base, not the version row: a refresh between a lost response
        // and its retry must not turn the retry into a second revision.
        { idempotencyKey: keyFor("policy", [base.policyId, revision]) }
      );
    }
    delete pendingKeys.current.policy;
    policyDirty.current = false;
    policyBase.current = { policyId: saved.policyId, version: saved.version };
    setPolicy(saved);
    setPolicyDraftValue(policyForm(saved));
    setNotice({ kind: "status", text: t.saved });
  }

  async function addVehicle() {
    if (vehicleDraft.name.trim() === "") throw new Error(t.required(t.vehicleName));
    const body = {
      name: vehicleDraft.name.trim(),
      registration:
        vehicleDraft.registration.trim() === "" ? null : vehicleDraft.registration.trim(),
      capacityGrams: kilograms(vehicleDraft.capacityKg, t.capacity)
    };
    const created = await postJson<VehicleSummary>(`${path}/vehicles`, body, {
      idempotencyKey: keyFor("vehicle", body)
    });
    delete pendingKeys.current.vehicle;
    setVehicles((current) => [...current.filter((item) => item.id !== created.id), created]);
    setVehicleDraft({ name: "", registration: "", capacityKg: "" });
    setNotice({ kind: "status", text: t.saved });
  }

  async function setVehicleActive(vehicle: VehicleSummary, active: boolean) {
    const updated = await patchJson<VehicleSummary>(`${path}/vehicles/${vehicle.id}`, { active });
    setVehicles((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function addGpsPoint() {
    const position = await new Promise<GeolocationPosition>((resolvePosition, reject) => {
      if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
        reject(new Error(t.geolocationUnavailable));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        resolvePosition,
        (error) =>
          reject(
            new Error(error.code === error.PERMISSION_DENIED ? t.geolocationDenied : error.message)
          ),
        { enableHighAccuracy: true, timeout: 30_000, maximumAge: 0 }
      );
    });
    setCorridorDraft((current) => ({
      ...current,
      points: appendRoutePoint(current.points, position.coords.latitude, position.coords.longitude)
    }));
  }

  async function addCorridor() {
    // A GPS fix still on its way belongs to this corridor; wait for it rather than save without it.
    if (isPending("setup-gps")) return;
    for (const [value, label] of [
      [corridorDraft.name, t.corridorName],
      [corridorDraft.originLabel, t.origin],
      [corridorDraft.destinationLabel, t.destination]
    ] as const) {
      if (value.trim() === "") throw new Error(t.required(label));
    }
    const route = parseRoutePoints(corridorDraft.points);
    if (!route.ok) throw new Error(t.routeError(route.reason, route.line));
    const body = {
      name: corridorDraft.name.trim(),
      originLabel: corridorDraft.originLabel.trim(),
      destinationLabel: corridorDraft.destinationLabel.trim(),
      routeGeometry: route.geometry
    };
    const created = await postJson<CorridorSummary>(`${path}/corridors`, body, {
      idempotencyKey: keyFor("corridor", body)
    });
    delete pendingKeys.current.corridor;
    setCorridors((current) => [...current.filter((item) => item.id !== created.id), created]);
    setCorridorDraft({ name: "", originLabel: "", destinationLabel: "", points: "" });
    setNotice({ kind: "status", text: t.saved });
  }

  async function setCorridorActive(corridor: CorridorSummary, active: boolean) {
    const updated = await patchJson<CorridorSummary>(`${path}/corridors/${corridor.id}`, {
      active
    });
    setCorridors((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  const canManage = settings?.viewerCanManage === true;
  const steps = [
    { label: t.timezone, done: settings?.timezone !== null && settings?.timezone !== undefined },
    { label: t.policy, done: policy !== null },
    { label: t.vehicles, done: vehicles.some((vehicle) => vehicle.active) },
    { label: t.corridors, done: corridors.some((corridor) => corridor.active) }
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const submit =
    (key: string, handler: () => Promise<void>, slot?: CreateSlot) => (event: FormEvent) => {
      event.preventDefault();
      act(key, handler, slot);
    };

  if (forbidden) return null;

  return (
    <section className="record-form fulfillment-setup-card" aria-label={t.setup}>
      <div className="section-heading">
        <p className="eyebrow">{t.setup}</p>
        <h3>{t.setupHeading}</h3>
      </div>
      <p className="shell-note">{t.setupIntro}</p>
      {notice !== null ? (
        <div className="row-actions">
          <p className="shell-note" role={notice.kind === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
          {notice.text.endsWith(t.refreshFailed) ? (
            <button
              className="secondary"
              type="button"
              onClick={() => setReload((current) => current + 1)}
            >
              {t.retryLoad}
            </button>
          ) : null}
        </div>
      ) : null}
      {!loaded ? (
        loadError === null ? (
          <p>{t.loading}</p>
        ) : (
          <div className="row-actions">
            <p className="shell-note" role="alert">
              {loadError}
            </p>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setLoadError(null);
                setReload((current) => current + 1);
              }}
            >
              {t.retryLoad}
            </button>
          </div>
        )
      ) : (
        <>
          <p>
            <strong>{t.setupProgress(doneCount, steps.length)}</strong>
          </p>
          <ol className="setup-steps">
            {steps.map((step) => (
              <li key={step.label}>
                {step.label} · {step.done ? t.stepDone : t.stepTodo}
              </li>
            ))}
          </ol>
          {canManage ? null : <p className="shell-note">{t.ownerOnly}</p>}

          <form onSubmit={submit("setup-timezone", saveTimezone)} aria-label={t.timezone}>
            <fieldset disabled={!canManage || reloading || isPending("setup-timezone")}>
              <legend>{t.timezone}</legend>
              <label>
                {t.timezone}
                <input
                  list="fulfillment-timezones"
                  placeholder={t.timezonePlaceholder}
                  aria-describedby="setup-timezone-hint"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </label>
              <datalist id="fulfillment-timezones">
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <Hint id="setup-timezone-hint">{t.timezoneHint}</Hint>
              {canManage ? (
                <div className="row-actions">
                  {device !== null && device !== timezone ? (
                    <button className="secondary" type="button" onClick={() => setTimezone(device)}>
                      {t.useDeviceTimezone(device)}
                    </button>
                  ) : null}
                  <button type="submit" disabled={isPending("setup-timezone")}>
                    {t.save}
                  </button>
                </div>
              ) : null}
            </fieldset>
          </form>

          <form onSubmit={submit("setup-policy", savePolicy, "policy")} aria-label={t.policy}>
            {/* Locked while saving: the saved result replaces the draft, so nothing typed during
                the save may be silently overwritten. */}
            <fieldset disabled={!canManage || reloading || isPending("setup-policy")}>
              <legend>
                {t.policy}
                {policy === null ? "" : ` · ${t.policyVersion(policy.version)}`}
              </legend>
              <label>
                {t.policyName}
                <input
                  required
                  maxLength={80}
                  placeholder={t.examplePolicyName}
                  value={policyDraft.name}
                  onChange={(event) => setPolicyDraft({ ...policyDraft, name: event.target.value })}
                />
              </label>
              <label>
                {t.targetLoad}
                <input
                  required
                  inputMode="decimal"
                  placeholder="6000"
                  aria-describedby="setup-target-hint setup-target-echo"
                  value={policyDraft.targetKg}
                  onChange={(event) =>
                    setPolicyDraft({ ...policyDraft, targetKg: event.target.value })
                  }
                />
              </label>
              <KgEcho id="setup-target-echo" value={policyDraft.targetKg} format={t.kgEcho} />
              <Hint id="setup-target-hint">{t.targetHint}</Hint>
              <label>
                {t.minimumLoad}
                <input
                  inputMode="decimal"
                  aria-describedby="setup-minimum-echo"
                  value={policyDraft.minimumKg}
                  onChange={(event) =>
                    setPolicyDraft({ ...policyDraft, minimumKg: event.target.value })
                  }
                />
              </label>
              <KgEcho id="setup-minimum-echo" value={policyDraft.minimumKg} format={t.kgEcho} />
              <label>
                {t.maxDiversion}
                <input
                  required
                  inputMode="numeric"
                  placeholder="2000"
                  value={policyDraft.maxDiversionMeters}
                  onChange={(event) =>
                    setPolicyDraft({ ...policyDraft, maxDiversionMeters: event.target.value })
                  }
                />
              </label>
              <label>
                {t.cutoff}
                <input
                  required
                  type="time"
                  value={policyDraft.cutoffLocalTime}
                  onChange={(event) =>
                    setPolicyDraft({ ...policyDraft, cutoffLocalTime: event.target.value })
                  }
                />
              </label>
              <label>
                {t.maxWait}
                <input
                  required
                  inputMode="numeric"
                  placeholder="72"
                  value={policyDraft.maxWaitHours}
                  onChange={(event) =>
                    setPolicyDraft({ ...policyDraft, maxWaitHours: event.target.value })
                  }
                />
              </label>
              <label>
                {t.leadDays}
                <input
                  required
                  inputMode="numeric"
                  placeholder="1"
                  value={policyDraft.fulfillmentLeadDays}
                  onChange={(event) =>
                    setPolicyDraft({ ...policyDraft, fulfillmentLeadDays: event.target.value })
                  }
                />
              </label>
              <fieldset>
                <legend>{t.fallbacks}</legend>
                {fallbackActions.map((action) => (
                  <label key={action} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={policyDraft.underThresholdFallback.includes(action)}
                      onChange={(event) =>
                        setPolicyDraft({
                          ...policyDraft,
                          underThresholdFallback: event.target.checked
                            ? [...policyDraft.underThresholdFallback, action]
                            : policyDraft.underThresholdFallback.filter((item) => item !== action)
                        })
                      }
                    />
                    {t.fallback[action]}
                  </label>
                ))}
              </fieldset>
              {canManage ? (
                <div className="row-actions">
                  <button type="submit" disabled={isPending("setup-policy")}>
                    {t.savePolicy}
                  </button>
                </div>
              ) : null}
            </fieldset>
          </form>

          <form onSubmit={submit("setup-vehicle", addVehicle, "vehicle")} aria-label={t.vehicles}>
            <h4>{t.vehicles}</h4>
            {vehicles.length === 0 ? <p className="shell-note">{t.noVehiclesYet}</p> : null}
            <ul className="setup-list">
              {vehicles.map((vehicle) => (
                <li key={vehicle.id}>
                  <span>
                    {vehicle.name}
                    {vehicle.registration === null ? "" : ` (${vehicle.registration})`} ·{" "}
                    {formatKilogramsForDisplay(vehicle.capacityGrams, { maximumFractionDigits: 0 })}
                    {vehicle.active ? "" : ` · ${t.retired}`}
                  </span>
                  {canManage ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={isPending(`vehicle-${vehicle.id}`)}
                      onClick={() =>
                        act(`vehicle-${vehicle.id}`, () =>
                          setVehicleActive(vehicle, !vehicle.active)
                        )
                      }
                    >
                      {vehicle.active ? t.retire : t.reactivate}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {canManage ? (
              <fieldset disabled={isPending("setup-vehicle")}>
                <legend>{t.addVehicle}</legend>
                <label>
                  {t.vehicleName}
                  <input
                    required
                    maxLength={80}
                    placeholder={t.exampleVehicleName}
                    value={vehicleDraft.name}
                    onChange={(event) =>
                      setVehicleDraft({ ...vehicleDraft, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  {t.registration}
                  <input
                    maxLength={32}
                    value={vehicleDraft.registration}
                    onChange={(event) =>
                      setVehicleDraft({ ...vehicleDraft, registration: event.target.value })
                    }
                  />
                </label>
                <label>
                  {t.capacity}
                  <input
                    required
                    inputMode="decimal"
                    placeholder="7000"
                    aria-describedby="setup-capacity-echo"
                    value={vehicleDraft.capacityKg}
                    onChange={(event) =>
                      setVehicleDraft({ ...vehicleDraft, capacityKg: event.target.value })
                    }
                  />
                </label>
                <KgEcho
                  id="setup-capacity-echo"
                  value={vehicleDraft.capacityKg}
                  format={t.kgEcho}
                />
                <div className="row-actions">
                  <button type="submit" disabled={isPending("setup-vehicle")}>
                    {t.addVehicle}
                  </button>
                </div>
              </fieldset>
            ) : null}
          </form>

          <form
            onSubmit={submit("setup-corridor", addCorridor, "corridor")}
            aria-label={t.corridors}
          >
            <h4>{t.corridors}</h4>
            {corridors.length === 0 ? <p className="shell-note">{t.noCorridorsYet}</p> : null}
            <ul className="setup-list">
              {corridors.map((corridor) => (
                <li key={corridor.id}>
                  <span>
                    {corridor.name} · {corridor.originLabel} → {corridor.destinationLabel} ·{" "}
                    {t.corridorLength(
                      (corridor.distanceMeters / 1000).toFixed(1),
                      corridor.geometryVersion
                    )}
                    {corridor.active ? "" : ` · ${t.retired}`}
                  </span>
                  {canManage ? (
                    <button
                      className="secondary"
                      type="button"
                      disabled={isPending(`corridor-${corridor.id}`)}
                      onClick={() =>
                        act(`corridor-${corridor.id}`, () =>
                          setCorridorActive(corridor, !corridor.active)
                        )
                      }
                    >
                      {corridor.active ? t.retire : t.reactivate}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {canManage ? (
              <fieldset disabled={isPending("setup-corridor")}>
                <legend>{t.addCorridor}</legend>
                <label>
                  {t.corridorName}
                  <input
                    required
                    maxLength={80}
                    value={corridorDraft.name}
                    onChange={(event) =>
                      setCorridorDraft({ ...corridorDraft, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  {t.origin}
                  <input
                    required
                    maxLength={120}
                    value={corridorDraft.originLabel}
                    onChange={(event) =>
                      setCorridorDraft({ ...corridorDraft, originLabel: event.target.value })
                    }
                  />
                </label>
                <label>
                  {t.destination}
                  <input
                    required
                    maxLength={120}
                    value={corridorDraft.destinationLabel}
                    onChange={(event) =>
                      setCorridorDraft({ ...corridorDraft, destinationLabel: event.target.value })
                    }
                  />
                </label>
                <label>
                  {t.routePoints}
                  <textarea
                    required
                    rows={4}
                    placeholder={"-1.2921, 36.8219\n-1.1000, 36.9000"}
                    aria-describedby="setup-route-hint"
                    value={corridorDraft.points}
                    onChange={(event) =>
                      setCorridorDraft({ ...corridorDraft, points: event.target.value })
                    }
                  />
                </label>
                <Hint id="setup-route-hint">{t.routeHint}</Hint>
                <div className="row-actions">
                  <button
                    className="secondary"
                    type="button"
                    disabled={isPending("setup-gps")}
                    onClick={() => act("setup-gps", addGpsPoint)}
                  >
                    {t.addGpsPoint}
                  </button>
                  <button
                    type="submit"
                    disabled={isPending("setup-corridor") || isPending("setup-gps")}
                  >
                    {t.addCorridor}
                  </button>
                </div>
              </fieldset>
            ) : null}
          </form>
        </>
      )}
    </section>
  );
}
