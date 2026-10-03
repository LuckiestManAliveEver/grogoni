import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  supportsRemovableDevice,
  pickRemovableDevice,
  type StorageTarget
} from "./offline-runtime";
import type { InstallStep } from "@grogoni/offline-runtime";

const stepLabel: Record<InstallStep, string> = {
  storage: "Checking storage",
  database: "Preparing local storage",
  snapshot: "Downloading business data",
  shell: "Downloading the offline application",
  runtime: "Installing pinned runtime",
  complete: "Installation complete"
};
const stepOrder: InstallStep[] = [
  "storage",
  "database",
  "snapshot",
  "shell",
  "runtime",
  "complete"
];

export interface OfflineInstallProgress {
  step: InstallStep;
  done: number;
  total: number;
}

export interface OfflineInstallWizardProps {
  open: boolean;
  busy: boolean;
  dataOnly: boolean;
  onDataOnlyChange: (value: boolean) => void;
  progress: OfflineInstallProgress | null;
  result: string | null;
  onInstall: (target: StorageTarget, handle: FileSystemDirectoryHandle | null) => void;
  onClose: () => void;
}

type Page = "introduction" | "destination" | "review" | "installing" | "summary";

const pageTitle: Record<Page, string> = {
  introduction: "Set up offline mode",
  destination: "Choose a destination",
  review: "Ready to install",
  installing: "Installing offline mode",
  summary: "Installation complete"
};

export function OfflineInstallWizard({
  open,
  busy,
  dataOnly,
  onDataOnlyChange,
  progress,
  result,
  onInstall,
  onClose
}: OfflineInstallWizardProps) {
  const [page, setPage] = useState<Page>("introduction");
  const [target, setTarget] = useState<StorageTarget>("local");
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [deviceError, setDeviceError] = useState("");
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setPage("introduction");
      setTarget("local");
      setHandle(null);
      setDeviceError("");
      return;
    }
    panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (busy) setPage("installing");
  }, [busy]);

  useEffect(() => {
    if (!busy && progress?.step === "complete") setPage("summary");
  }, [busy, progress]);

  if (!open) return null;

  async function chooseFolder() {
    setDeviceError("");
    try {
      setHandle(await pickRemovableDevice());
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : "Could not open the device picker.");
    }
  }

  const canLeaveDestination = target === "local" || handle !== null;
  const stepIndex = progress ? stepOrder.indexOf(progress.step) : -1;
  const percent =
    progress && progress.total > 0 ? Math.round((100 * progress.done) / progress.total) : 0;

  return createPortal(
    <div className="offline-wizard-backdrop" role="presentation">
      <div
        className="offline-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <ol className="offline-wizard-steps" aria-hidden="true">
          {(["introduction", "destination", "review", "installing", "summary"] as Page[]).map(
            (entry, index) => (
              <li
                key={entry}
                className={
                  entry === page
                    ? "offline-wizard-step offline-wizard-step-current"
                    : "offline-wizard-step"
                }
              >
                {index + 1}
              </li>
            )
          )}
        </ol>
        <h2 id={titleId} className="offline-wizard-title">
          {pageTitle[page]}
        </h2>

        {page === "introduction" && (
          <div className="offline-wizard-body">
            <p>
              This downloads a snapshot of your products, customers, invoices and orders so you can
              keep working without a connection. Catalogue changes, customer creation, stock counts,
              and creating, editing and confirming invoices will stay on this device until you
              choose to sync. Payments, checkout and account changes require an online connection.
              Receipts can be scanned offline if you enable on-device scanning below; confirming a
              scan into a supplier and purchase record still requires reconnecting.
            </p>
            <label className="offline-wizard-checkbox">
              <input
                type="checkbox"
                checked={dataOnly}
                onChange={(event) => onDataOnlyChange(event.target.checked)}
              />
              Install business data only (AI remains unavailable offline)
            </label>
            <div className="offline-wizard-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="offline-wizard-primary"
                onClick={() => setPage("destination")}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {page === "destination" && (
          <div className="offline-wizard-body">
            <p>Select where the offline copy of your business data should live.</p>
            <label className="offline-wizard-option">
              <input
                type="radio"
                name="offline-storage-target"
                checked={target === "local"}
                onChange={() => {
                  setTarget("local");
                  setDeviceError("");
                }}
              />
              <span>
                <strong>Local storage</strong>
                <br />
                Kept in this browser, on this device only.
              </span>
            </label>
            <label className="offline-wizard-option">
              <input
                type="radio"
                name="offline-storage-target"
                checked={target === "removable"}
                disabled={!supportsRemovableDevice()}
                onChange={() => setTarget("removable")}
              />
              <span>
                <strong>Removable device</strong>
                <br />
                Written to a USB drive or SD card you choose, so it can move between computers.
                {!supportsRemovableDevice() && " Not supported by this browser."}
              </span>
            </label>
            {target === "removable" && (
              <div className="offline-wizard-device-picker">
                <button type="button" onClick={() => void chooseFolder()}>
                  {handle ? `Change folder (${handle.name})` : "Choose folder…"}
                </button>
                {handle && <p role="status">Selected: {handle.name}</p>}
                {deviceError && <p role="alert">{deviceError}</p>}
              </div>
            )}
            <div className="offline-wizard-actions">
              <button type="button" onClick={() => setPage("introduction")}>
                Back
              </button>
              <button
                type="button"
                className="offline-wizard-primary"
                disabled={!canLeaveDestination}
                onClick={() => setPage("review")}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {page === "review" && (
          <div className="offline-wizard-body">
            <p>
              Destination:{" "}
              <strong>
                {target === "local" ? "Local storage" : `Removable device (${handle?.name})`}
              </strong>
            </p>
            <p>
              Allow at least 16 MiB for business data. Installation reserves at least 256 MiB or 20%
              of the available storage quota, whichever is larger. Storage estimates cannot
              guarantee free space for other apps.
            </p>
            {!dataOnly && (
              <p>
                Downloads a small on-device assistant model (WebGPU required; about 1 GB of device
                memory). The exact agent and model version are pinned at install time and will not
                change on reconnect. It answers from the prompt alone, with no catalogue, order,
                customer or account data - unsupported devices fall back to business data only.
              </p>
            )}
            <div className="offline-wizard-actions">
              <button type="button" onClick={() => setPage("destination")}>
                Back
              </button>
              <button
                type="button"
                className="offline-wizard-primary"
                onClick={() => onInstall(target, handle)}
              >
                Install
              </button>
            </div>
          </div>
        )}

        {page === "installing" && !busy && progress?.step !== "complete" && (
          <div className="offline-wizard-body">
            <p role="alert">{result ?? "The installation could not finish."}</p>
            <div className="offline-wizard-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="offline-wizard-primary"
                onClick={() => setPage("review")}
              >
                Try again
              </button>
            </div>
          </div>
        )}
        {page === "installing" && (busy || progress?.step === "complete") && (
          <div className="offline-wizard-body">
            <ul className="offline-wizard-checklist">
              {stepOrder.map((entry, index) => (
                <li
                  key={entry}
                  className={
                    stepIndex > index
                      ? "offline-wizard-checklist-done"
                      : stepIndex === index
                        ? "offline-wizard-checklist-active"
                        : ""
                  }
                >
                  {stepLabel[entry]}
                </li>
              ))}
            </ul>
            <progress
              className="offline-wizard-progress"
              aria-label="Offline installation progress"
              value={progress?.done ?? 0}
              max={Math.max(1, progress?.total ?? 1)}
            />
            <p role="status">
              {progress ? `${stepLabel[progress.step]}… ${percent}%` : "Starting…"}
            </p>
          </div>
        )}

        {page === "summary" && (
          <div className="offline-wizard-body">
            <p role="status">{result ?? "Your device is ready to work offline."}</p>
            <div className="offline-wizard-actions">
              <button type="button" className="offline-wizard-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
