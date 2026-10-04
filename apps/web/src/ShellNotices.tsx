import { Suspense, lazy } from "react";
import type { AccountShopSummary } from "@grogoni/shared-types";
import { AuthenticationActionMessage } from "./AuthenticationActionMessage";
import { isRedundantAgentErrorMessage } from "./chat-message-plumbing";
import StaffInvitationsPrompt from "./StaffInvitationsPrompt";
import { LazyModuleErrorBoundary } from "./LazyModuleErrorBoundary";
import { loadLazyModuleWithRecovery, workspaceModuleKeys } from "./lazy-module-recovery";
import { authenticationRoute } from "./routes";
import { readPendingJoin } from "./staff-join-link";
import { staffCopy } from "./staff-copy";

// Renders nothing unless someone asked to connect: loaded after the shell, not with it.
const ConnectionRequestsPrompt = lazy(() =>
  loadLazyModuleWithRecovery(
    workspaceModuleKeys.connectionRequests,
    () => import("./ConnectionRequestsPrompt")
  )
);

// The notices at the top of the app shell: the last action's status line, invitations to join a
// business waiting for the signed-in person (docs/architecture/staff-invitations.md), and requests
// to connect from people who found them in their phonebook.
// Extracted from GrogoniApplication so the shell stays within its modularity budget.
export default function ShellNotices(props: {
  /** Empty hides the status line (for example on the sign-in screens). */
  statusMessage: string;
  working: boolean;
  /** The signed-in account, or null while signing in, bootstrapping or signed out. */
  accountId: string | null;
  /** Signed out and not on the sign-in screens: where a join-link visitor is asked to sign in. */
  signedOut: boolean;
  onJoinedShop: (shop: AccountShopSummary) => Promise<void> | void;
}) {
  return (
    <>
      {props.statusMessage.length > 0 && !isRedundantAgentErrorMessage(props.statusMessage) ? (
        <div className="app-action-notice" role="status" aria-live="polite">
          {props.working ? (
            "Working…"
          ) : (
            <AuthenticationActionMessage message={props.statusMessage} />
          )}
        </div>
      ) : null}
      {props.signedOut && readPendingJoin(window.localStorage) !== null ? (
        <div className="app-action-notice staff-join-banner" role="status">
          <span>{staffCopy().joinBanner}</span>{" "}
          <a href={authenticationRoute("login")}>{staffCopy().joinBannerLogIn}</a>{" "}
          <a href={authenticationRoute("signup")}>{staffCopy().joinBannerSignUp}</a>
        </div>
      ) : null}
      {props.accountId === null ? null : (
        <StaffInvitationsPrompt accountId={props.accountId} onJoined={props.onJoinedShop} />
      )}
      {props.accountId === null ? null : (
        <LazyModuleErrorBoundary
          moduleKey={workspaceModuleKeys.connectionRequests}
          label="Connection requests"
        >
          <Suspense fallback={null}>
            <ConnectionRequestsPrompt accountId={props.accountId} />
          </Suspense>
        </LazyModuleErrorBoundary>
      )}
    </>
  );
}
