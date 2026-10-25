import { useEffect, useState } from "react";
import type {
  ChannelProvider,
  ChannelProviderReadiness,
  ConnectedMailboxProviderSummary
} from "@grogoni/shared-types";
import { fetchFreshJson, postJson } from "./api-helpers";
import { formatChannelProvider } from "./formatters";
import { getUserFacingErrorMessage } from "./user-facing-error";

export default function MessagingConnectionsPanel({ businessId }: { businessId: string }) {
  const [providers, setProviders] = useState<ChannelProviderReadiness[]>([]);
  const [mailboxes, setMailboxes] = useState<ConnectedMailboxProviderSummary[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [provider, setProvider] = useState<ChannelProvider>("telegram");
  const [grant, setGrant] = useState<{ linkUrl: string; token: string; expiresAt: string } | null>(
    null
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchFreshJson<{ providers: ChannelProviderReadiness[] }>(
        `/businesses/${businessId}/channels/readiness`
      ),
      fetchFreshJson<{ providers: ConnectedMailboxProviderSummary[] }>(
        `/businesses/${businessId}/mailboxes/providers`
      ),
      fetchFreshJson<{ id: string; name: string }[]>(`/businesses/${businessId}/customers`)
    ])
      .then(([channels, email, people]) => {
        if (cancelled) return;
        setProviders(channels.providers);
        setMailboxes(email.providers);
        setCustomers(people);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);
  const linkable = providers.filter(
    (item) =>
      item.configured &&
      item.authorized &&
      !["grogoni", "email", "native_sms", "tiktok"].includes(item.provider)
  );
  const canLinkCustomer = !!customerId && linkable.some((item) => item.provider === provider);
  async function linkCustomer() {
    if (!customerId || !linkable.some((item) => item.provider === provider)) return;
    setBusy(true);
    setGrant(null);
    setMessage("");
    try {
      setGrant(
        await postJson(`/businesses/${businessId}/customers/${customerId}/channel-link-grants`, {
          provider
        })
      );
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function connectMailbox(selected: string) {
    setBusy(true);
    setMessage("");
    try {
      const authorization = await postJson<{ authorizationUrl: string }>(
        `/businesses/${businessId}/mailboxes/oauth/${selected}/start`,
        {}
      );
      window.location.assign(authorization.authorizationUrl);
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
      setBusy(false);
    }
  }
  return (
    <section aria-label="Business messaging connections" className="record-form">
      <h3>Business messaging connections</h3>
      <p>
        Connected channels keep replies in the customer’s Grogoni conversation. App handoffs send
        from the account you choose in that app.
      </p>
      {providers.length === 0 && !message ? <p>Loading connections…</p> : null}
      <ul>
        {providers
          .filter((item) => item.provider !== "grogoni")
          .map((item) => (
            <li key={item.provider}>
              {formatChannelProvider(item.provider)} ·{" "}
              {item.configured && item.authorized
                ? "Ready to link"
                : item.provider === "tiktok"
                  ? "Use app handoff"
                  : "Business authorization required"}
            </li>
          ))}
      </ul>
      <div className="button-row">
        {mailboxes.map((mailbox) => (
          <button
            key={mailbox.provider}
            type="button"
            disabled={busy || !mailbox.configured}
            onClick={() => void connectMailbox(mailbox.provider)}
          >
            Connect {mailbox.displayName}
          </button>
        ))}
      </div>
      {mailboxes.some((mailbox) => !mailbox.configured) ? (
        <p>Gmail and Outlook need business authorization before a mailbox can be connected.</p>
      ) : null}
      {linkable.length ? (
        <>
          <label>
            Customer
            <select
              aria-label="Customer"
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                setGrant(null);
              }}
            >
              <option value="">Choose a customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Channel
            <select
              aria-label="Channel"
              value={linkable.some((item) => item.provider === provider) ? provider : ""}
              onChange={(event) => {
                setProvider(event.target.value as ChannelProvider);
                setGrant(null);
              }}
            >
              <option value="">Choose a channel</option>
              {linkable.map((item) => (
                <option key={item.provider} value={item.provider}>
                  {formatChannelProvider(item.provider)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !canLinkCustomer}
            onClick={() => void linkCustomer()}
          >
            Create customer verification link
          </button>
        </>
      ) : (
        <p>
          Authorize a business messaging account to link customers. You can use the app handoff
          buttons above in the meantime.
        </p>
      )}
      {grant ? (
        <div>
          <p>
            Give this link and verification message to the customer. They must send the message from
            their own account to connect this channel. The link expires in 15 minutes.
          </p>
          <label>
            Customer verification link
            <input
              readOnly
              value={grant.linkUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <label>
            Verification message
            <input
              readOnly
              value={`link ${grant.token}`}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
