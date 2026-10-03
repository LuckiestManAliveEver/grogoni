import { useEffect, useState } from "react";
import { useAsyncActions } from "../../hooks/useAsyncActions";
import { getUserFacingErrorMessage } from "../../user-facing-error";
import { apiFetch } from "../../lib/api";
import { AuthenticationActionMessage } from "../../AuthenticationActionMessage";

interface AccountDeletionRequestSummary {
  id: string;
  businessId: string;
  status: string;
  requestedAt: string;
  anonymizeAfter: string;
}

export interface AccountRestorationResult {
  request: AccountDeletionRequestSummary;
  business: {
    id: string;
    name: string;
    language: "en" | "sw";
    grogoniId: string;
  };
  membership: { role: string };
}

export function AccountRestorationPanel({
  onCancel,
  onRestored
}: {
  onCancel: () => void;
  onRestored: (result: AccountRestorationResult) => void;
}) {
  const [requests, setRequests] = useState<AccountDeletionRequestSummary[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState("Loading recovery requests…");
  const { isPending, runAction } = useAsyncActions();

  useEffect(() => {
    let active = true;
    void apiFetch<{ requests: AccountDeletionRequestSummary[] }>("/account-restoration/requests")
      .then((response) => {
        if (!active) return;
        setRequests(response.requests);
        setSelectedRequestId(response.requests[0]?.id ?? "");
        setStatus(
          response.requests.length === 0
            ? "No account is eligible for restoration in this signed-in account."
            : "Select the deletion request and re-enter your PIN to restore access."
        );
      })
      .catch((error: unknown) => {
        if (active) setStatus(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);

  async function restoreAccount() {
    if (selectedRequestId === "" || !/^\d{4}$/.test(pin)) {
      setStatus("Select a request and enter your 4-digit PIN.");
      return;
    }
    await runAction("account-restore", async () => {
      try {
        const result = await apiFetch<AccountRestorationResult>(
          `/account-restoration/${encodeURIComponent(selectedRequestId)}`,
          { method: "POST", body: { pin } }
        );
        onRestored(result);
      } catch (error) {
        setStatus(errorMessage(error));
      }
    });
  }

  return (
    <main className="setup-panel" aria-label="Restore deleted account">
      <section className="setup-card">
        <div className="section-heading">
          <p className="eyebrow">Account recovery</p>
          <h2>Restore account access</h2>
        </div>
        <p>
          Recovery is available only before the 30-day anonymization deadline. Restoring cancels the
          pending deletion and reactivates the associated shop.
        </p>
        {requests.length > 0 ? (
          <>
            <label>
              Deletion request
              <select
                value={selectedRequestId}
                onChange={(event) => setSelectedRequestId(event.target.value)}
              >
                {requests.map((request) => (
                  <option key={request.id} value={request.id}>
                    {request.id.slice(0, 8)} · recover by {formatDate(request.anonymizeAfter)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Owner PIN
              <input
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                maxLength={4}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
              />
            </label>
          </>
        ) : null}
        <p className="setup-status" role="status">
          <AuthenticationActionMessage message={status} />
        </p>
        <div className="row-actions">
          <button className="secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void restoreAccount()}
            disabled={requests.length === 0 || isPending("account-restore")}
          >
            {isPending("account-restore") ? "Restoring…" : "Restore account"}
          </button>
        </div>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return getUserFacingErrorMessage(error);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium" }).format(new Date(value));
}
