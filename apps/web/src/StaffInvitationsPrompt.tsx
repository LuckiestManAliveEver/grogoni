import { useEffect, useState } from "react";
import type { AccountShopSummary, MyStaffInvitationSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { fetchFreshJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { staffCopy } from "./staff-copy";
import { clearPendingJoin, readPendingJoin, type PendingJoin } from "./staff-join-link";
import { ApiRequestError } from "./lib/api";

// Invitations waiting for the signed-in person (docs/architecture/staff-invitations.md). Mounted
// in the app shell for every signed-in account, including someone who just signed up and has no
// shop of their own, which is exactly where a new salesperson or driver lands. Nothing is granted
// until they press Accept; after that the shop is handed to `onJoined` so the app switches to it
// without a reload. Renders nothing when there is nothing to answer.
export default function StaffInvitationsPrompt(props: {
  accountId: string;
  onJoined: (shop: AccountShopSummary) => Promise<void> | void;
}) {
  const t = staffCopy();
  const { isPending, runAction } = useAsyncActions();
  const [invitations, setInvitations] = useState<MyStaffInvitationSummary[]>([]);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  // The join link this device was opened with, if any: its secret is sent with Accept as proof
  // the person received the message on the invited number.
  const [pendingJoin, setPendingJoin] = useState<PendingJoin | null>(() =>
    readPendingJoin(window.localStorage)
  );
  const [linkNotForYou, setLinkNotForYou] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetchFreshJson<{ invitations: MyStaffInvitationSummary[] }>("/v1/staff-invitations")
        .then((loaded) => {
          if (cancelled) return;
          setInvitations(loaded.invitations);
          const link = readPendingJoin(window.localStorage);
          setLinkNotForYou(
            link !== null && !loaded.invitations.some((item) => item.id === link.invitationId)
          );
        })
        .catch(() => {
          // Invitations are an optional prompt; a failed check simply shows nothing new.
        });
    };
    check();
    // Someone already signed in sees a new invitation when they come back to the app, without
    // reloading (the owner usually tells them "I've invited you" while the app is in the background).
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [props.accountId]);

  function forgetLink() {
    clearPendingJoin(window.localStorage);
    setPendingJoin(null);
    setLinkNotForYou(false);
  }

  function answer(invitation: MyStaffInvitationSummary, accept: boolean) {
    setMessage("");
    setFailed(false);
    void runAction(`staff-answer-${invitation.id}`, async () => {
      try {
        if (accept) {
          const joined = await postJson<AccountShopSummary>(
            `/v1/staff-invitations/${invitation.id}/accept`,
            pendingJoin?.invitationId === invitation.id ? { joinToken: pendingJoin.joinToken } : {}
          );
          if (pendingJoin?.invitationId === invitation.id) forgetLink();
          setInvitations((current) => current.filter((item) => item.id !== invitation.id));
          await props.onJoined({ business: joined.business, membership: joined.membership });
          setMessage(t.joined(joined.business.name));
        } else {
          await postJson(`/v1/staff-invitations/${invitation.id}/decline`, {});
          if (pendingJoin?.invitationId === invitation.id) forgetLink();
          setInvitations((current) => current.filter((item) => item.id !== invitation.id));
        }
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === "staff_invitation_link_invalid") {
          forgetLink();
        }
        setFailed(true);
        setMessage(getUserFacingErrorMessage(error));
      }
    });
  }

  if (invitations.length === 0 && message === "" && !linkNotForYou) return null;

  return (
    <section className="record-form staff-invitations-prompt" aria-label={t.invitations}>
      {linkNotForYou ? (
        <div className="row-actions">
          <p className="shell-note" role="alert">
            {t.joinLinkNotForYou}
          </p>
          <button className="secondary" type="button" onClick={forgetLink}>
            {t.dismiss}
          </button>
        </div>
      ) : null}
      {message.length > 0 ? (
        <p className="shell-note" role={failed ? "alert" : "status"}>
          {message}
        </p>
      ) : null}
      {invitations.map((invitation) => (
        <article className="mini-card" key={invitation.id}>
          <strong>
            {t.invitationFrom(
              invitation.businessName,
              t.role[invitation.role],
              invitation.invitedByName
            )}
          </strong>
          <small>{t.roleHelp[invitation.role]}</small>
          <div className="row-actions">
            <button
              type="button"
              disabled={isPending(`staff-answer-${invitation.id}`)}
              onClick={() => answer(invitation, true)}
            >
              {t.accept}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={isPending(`staff-answer-${invitation.id}`)}
              onClick={() => answer(invitation, false)}
            >
              {t.decline}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
