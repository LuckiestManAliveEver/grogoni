import type { NetworkInviteSummary } from "@grogoni/shared-types";

import {
  type NetworkGraphSummary,
  type OAuthProviderSummary,
  type SocialSignupProvider
} from "./grogoni-application-shared";

import { formatDate } from "./formatters";

import { NetworkNodeList } from "./NetworkNodeList";
import CanonicalContactsCard from "./CanonicalContactsCard";

export interface NetworkSurfaceProps {
  businessId: string;
  graph: NetworkGraphSummary | null;
  invites: NetworkInviteSummary[];
  providers: OAuthProviderSummary[];
  onRefresh: () => void;
  onSyncContacts: () => void;
  onSyncSocial: (provider: SocialSignupProvider) => void;
  onRoute: (targetNodeId?: string) => void;
  onApproveRoute: (routeId: string) => void;
  onRejectRoute: (routeId: string) => void;
  onDisconnectSource: (sourceId: string) => void;
}

export function NetworkSurface(props: NetworkSurfaceProps) {
  const directNodes = props.graph?.nodes.filter((node) => node.degree === 1) ?? [];
  const directPhoneNodes = directNodes.filter((node) => node.sourceType === "phone_contact");
  const directSocialNodes = directNodes.filter((node) => node.sourceType === "social");
  const extendedNodes = props.graph?.nodes.filter((node) => node.degree === 2) ?? [];
  const activeSources = props.graph?.sources.filter((source) => source.status === "active") ?? [];
  const configuredProviders = props.providers.filter(
    (provider) =>
      provider.configured && provider.enabled !== false && provider.implemented !== false
  );

  return (
    <>
      <section className="record-list network-card">
        <div className="surface-header-row">
          <div>
            <p className="eyebrow">Commerce graph</p>
            <h3>Network</h3>
            <p className="shell-note">
              Your contacts help Grogoni build your first commerce network. Social connections
              expand it; friends-of-friends are reached through friends' agents.
            </p>
          </div>
          <button className="secondary" type="button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>

        <div className="network-actions">
          <button type="button" onClick={props.onSyncContacts}>
            Sync contacts
          </button>
          {configuredProviders.map((provider) => (
            <button
              className="secondary"
              key={provider.id}
              type="button"
              onClick={() => props.onSyncSocial(provider.id)}
            >
              Connect {provider.displayName}
            </button>
          ))}
        </div>

        <div className="network-metrics">
          <span>
            <strong>{directPhoneNodes.length}</strong>
            Phone contacts
          </span>
          <span>
            <strong>{directSocialNodes.length}</strong>
            Social connections
          </span>
          <span>
            <strong>{extendedNodes.length}</strong>
            Agent-routed
          </span>
        </div>

        <div className="network-columns">
          <NetworkNodeList title="Direct contacts" nodes={directPhoneNodes} />
          <NetworkNodeList title="Direct social" nodes={directSocialNodes} />
          <div className="network-list">
            <h4>Reachable through agents</h4>
            {extendedNodes.length === 0 ? (
              <p className="shell-note">Second-degree people appear here after sync.</p>
            ) : (
              extendedNodes.map((node) => (
                <article key={node.id}>
                  <span>{node.displayName}</span>
                  <small>{node.visibilityStatus.replace("_", " ")}</small>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => props.onRoute(node.id)}
                  >
                    Route through agent
                  </button>
                </article>
              ))
            )}
          </div>
        </div>

        {activeSources.length > 0 ? (
          <div className="network-source-list">
            <h4>Connected sources</h4>
            {activeSources.map((source) => (
              <article key={source.id}>
                <span>{source.displayName}</span>
                <small>
                  {source.directCount} direct · {source.extendedCount} extended
                </small>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => props.onDisconnectSource(source.id)}
                >
                  Disconnect
                </button>
              </article>
            ))}
          </div>
        ) : null}

        <div className="network-source-list">
          <h4>Invite delivery</h4>
          {props.invites.length === 0 ? (
            <p className="shell-note">No contact invites have been queued.</p>
          ) : (
            props.invites.map((invite) => (
              <article key={invite.id}>
                <span>{invite.contactName}</span>
                <small>
                  {invite.channel} · {invite.destination} · {invite.status}
                </small>
                <small>{formatDate(invite.createdAt)}</small>
              </article>
            ))
          )}
        </div>

        {props.graph !== null && props.graph.routes.length > 0 ? (
          <div className="network-route-list">
            <h4>Agent routes</h4>
            {props.graph.routes.map((route) => (
              <article key={route.id}>
                <span>{route.status.replace("_", " ")}</span>
                <strong>{route.path.join(" -> ")}</strong>
                <small>{route.requestText}</small>
                {route.status === "pending_permission" ? (
                  <div className="row-actions compact-actions">
                    <button type="button" onClick={() => props.onApproveRoute(route.id)}>
                      Approve
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => props.onRejectRoute(route.id)}
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>
      <CanonicalContactsCard businessId={props.businessId} />
    </>
  );
}
