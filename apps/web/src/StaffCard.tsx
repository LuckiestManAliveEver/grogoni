import { useEffect, useState, type FormEvent } from "react";
import type { CountryCode } from "libphonenumber-js";
import type {
  BusinessRole,
  StaffInvitationSummary,
  StaffMemberSummary,
  StaffOverviewSummary
} from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { deleteJson, fetchFreshJson, patchJson, postJson } from "./api-helpers";
import { ApiRequestError } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { PhoneNumberField } from "./PhoneNumberField";
import { staffCopy } from "./staff-copy";
import { buildJoinLink, emailLink, smsLink, whatsAppLink } from "./staff-join-link";

// Staff management for the open business (docs/architecture/staff-invitations.md). Owners and
// managers invite people by phone with a role, see who is waiting and who has joined, change roles
// and remove people. Which roles a viewer may grant, and which members they may change, come from
// the server (`grantableRoles`, `manageable`), so this card mirrors no role table. People who may
// not manage staff get a 403 on the list and see only "Leave this business" (never for the owner).

function defaultCountry(): CountryCode {
  const region =
    typeof navigator === "undefined"
      ? undefined
      : (navigator.language ?? "").split("-")[1]?.toUpperCase();
  return (region ?? "KE") as CountryCode;
}

export default function StaffCard(props: {
  businessId: string;
  businessName: string;
  /** Only decides whether "Leave" is offered when the list is refused; the server decides access. */
  viewerRole: string;
  onLeft?: () => void;
}) {
  const t = staffCopy();
  const path = `/businesses/${props.businessId}/staff`;
  const revision = useApiMutationRevision(path);
  const { isPending, runAction } = useAsyncActions();
  const [overview, setOverview] = useState<StaffOverviewSummary | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<{ kind: "status" | "error"; text: string } | null>(null);
  const [draft, setDraft] = useState({ name: "", phone: "", role: "" as BusinessRole | "" });
  const [country, setCountry] = useState<CountryCode>(defaultCountry);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [lastInvite, setLastInvite] = useState<StaffInvitationSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFreshJson<StaffOverviewSummary>(path)
      .then((loaded) => {
        if (cancelled) return;
        setOverview(loaded);
        setForbidden(false);
        setLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiRequestError && error.status === 403) setForbidden(true);
        else setLoadError(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [path, revision, reload]);

  function act(key: string, action: () => Promise<void>) {
    setNotice(null);
    void runAction(key, async () => {
      try {
        await action();
      } catch (error) {
        setNotice({ kind: "error", text: getUserFacingErrorMessage(error) });
      }
    });
  }

  async function sendInvite(event: FormEvent) {
    event.preventDefault();
    act("staff-invite", async () => {
      const role = draft.role === "" ? overview?.grantableRoles[0] : draft.role;
      const created = await postJson<StaffInvitationSummary>(`${path}/invitations`, {
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        country,
        role: role ?? ""
      });
      setLastInvite(created);
      setDraft({ name: "", phone: "", role: "" });
      setOverview((current) =>
        current === null
          ? current
          : {
              ...current,
              invitations: [{ ...created, needsReinvite: false }, ...current.invitations]
            }
      );
      setNotice({
        kind: "status",
        text: t.invited(created.inviteeName, created.destination, created.channel)
      });
    });
  }

  function inviteMessage(invitation: StaffInvitationSummary): string | null {
    if (invitation.joinToken === undefined) return null;
    const link = buildJoinLink(window.location.origin, invitation.id, invitation.joinToken);
    return t.shareText(props.businessName, t.role[invitation.role], link, invitation.channel);
  }

  /** Copies the invitation (with its link) to the clipboard; the share sheet only as a fallback. */
  async function copyLink(invitation: StaffInvitationSummary) {
    const text =
      inviteMessage(invitation) ??
      t.shareTextWithoutLink(props.businessName, t.role[invitation.role]);
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      setNotice({ kind: "status", text: t.copied });
      return;
    }
    const nav = navigator as Navigator & { share?: (data: { text: string }) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ text });
      } catch (error) {
        // Closing the share sheet is a choice, not a failure.
        if (error instanceof DOMException && error.name === "AbortError") return;
        throw error;
      }
    }
  }

  async function revoke(invitation: StaffInvitationSummary) {
    await postJson(`${path}/invitations/${invitation.id}/revoke`, {});
    setOverview((current) =>
      current === null
        ? current
        : {
            ...current,
            invitations: current.invitations.filter((item) => item.id !== invitation.id)
          }
    );
    if (lastInvite?.id === invitation.id) setLastInvite(null);
    setConfirming(null);
  }

  async function changeRole(member: StaffMemberSummary, role: BusinessRole) {
    const updated = await patchJson<StaffMemberSummary>(`${path}/members/${member.membershipId}`, {
      role
    });
    setOverview((current) =>
      current === null
        ? current
        : {
            ...current,
            members: current.members.map((item) =>
              item.membershipId === updated.membershipId ? updated : item
            )
          }
    );
    setNotice({ kind: "status", text: t.saved });
  }

  async function remove(member: StaffMemberSummary) {
    await deleteJson(`${path}/members/${member.membershipId}`);
    setConfirming(null);
    setOverview((current) =>
      current === null
        ? current
        : {
            ...current,
            members: current.members.filter((item) => item.membershipId !== member.membershipId)
          }
    );
    setNotice({ kind: "status", text: t.removed });
  }

  async function leave() {
    await postJson(`${path}/leave`, {});
    setConfirming(null);
    props.onLeft?.();
  }

  const leaveControls =
    props.viewerRole === "owner" ? null : confirming === "leave" ? (
      <div className="row-actions">
        <button
          type="button"
          disabled={isPending("staff-leave")}
          onClick={() => act("staff-leave", leave)}
        >
          {t.confirmLeave}
        </button>
        <button className="secondary" type="button" onClick={() => setConfirming(null)}>
          {t.cancel}
        </button>
      </div>
    ) : (
      <button className="secondary" type="button" onClick={() => setConfirming("leave")}>
        {t.leave}
      </button>
    );

  const noticeLine =
    notice === null ? null : (
      <p className="shell-note" role={notice.kind === "error" ? "alert" : "status"}>
        {notice.text}
      </p>
    );

  if (forbidden) {
    if (props.viewerRole === "owner") return null;
    return (
      <section className="record-form staff-card" aria-label={t.staff}>
        <div className="section-heading">
          <p className="eyebrow">{t.staff}</p>
        </div>
        {noticeLine}
        {leaveControls}
      </section>
    );
  }

  return (
    <section className="record-form staff-card" aria-label={t.staff}>
      <div className="section-heading">
        <p className="eyebrow">{t.staff}</p>
        <h3>{t.heading}</h3>
      </div>
      <p className="shell-note">{t.intro}</p>
      {noticeLine}
      {overview === null ? (
        loadError === null ? (
          <p>{t.loading}</p>
        ) : (
          <div className="row-actions">
            <p className="shell-note" role="alert">
              {loadError}
            </p>
            <button className="secondary" type="button" onClick={() => setReload((n) => n + 1)}>
              {t.retry}
            </button>
          </div>
        )
      ) : (
        <>
          <h4>{t.members}</h4>
          <ul className="setup-list staff-members">
            {overview.members.map((member) => (
              <li key={member.membershipId}>
                <span>
                  {member.displayName || member.phone || member.userId}
                  {member.isYou ? ` (${t.you})` : ""}
                  {member.phone !== null && member.displayName ? ` · ${member.phone}` : ""}
                  {" · "}
                  {t.role[member.role]}
                  {member.confirmedByLink ? ` · ${t.confirmedByLink}` : ""}
                </span>
                {member.manageable ? (
                  <div className="row-actions">
                    <select
                      aria-label={`${t.changeRole}: ${member.displayName || member.phone || ""}`}
                      value={member.role}
                      disabled={isPending(`staff-role-${member.membershipId}`)}
                      onChange={(event) =>
                        act(`staff-role-${member.membershipId}`, () =>
                          changeRole(member, event.target.value as BusinessRole)
                        )
                      }
                    >
                      {[member.role, ...overview.grantableRoles]
                        .filter((role, index, all) => all.indexOf(role) === index)
                        .map((role) => (
                          <option key={role} value={role}>
                            {t.role[role]}
                          </option>
                        ))}
                    </select>
                    {confirming === member.membershipId ? (
                      <>
                        <button
                          type="button"
                          disabled={isPending(`staff-remove-${member.membershipId}`)}
                          onClick={() =>
                            act(`staff-remove-${member.membershipId}`, () => remove(member))
                          }
                        >
                          {t.confirmRemove(member.displayName || member.phone || "")}
                        </button>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => setConfirming(null)}
                        >
                          {t.cancel}
                        </button>
                      </>
                    ) : (
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => setConfirming(member.membershipId)}
                      >
                        {t.remove}
                      </button>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          <h4>{t.pending}</h4>
          {overview.invitations.length === 0 ? (
            <p className="shell-note">{t.noPending}</p>
          ) : (
            <ul className="setup-list staff-invitations">
              {overview.invitations.map((invitation) => (
                <li key={invitation.id}>
                  <span>
                    {invitation.inviteeName} · {invitation.destination} · {t.role[invitation.role]}{" "}
                    · {t.expires(new Date(invitation.expiresAt).toLocaleDateString())}
                  </span>
                  {invitation.needsReinvite ? (
                    <small className="shell-note" role="note">
                      {t.needsReinvite}
                    </small>
                  ) : null}
                  <div className="row-actions">
                    {(() => {
                      const message = inviteMessage(invitation);
                      if (message === null) return null;
                      // Delivered from the owner's own phone, straight to the invited number.
                      return invitation.channel === "phone" ? (
                        <>
                          <a
                            className="button-like"
                            href={smsLink(invitation.destination, message)}
                          >
                            {t.sendSms}
                          </a>
                          <a
                            className="button-like"
                            href={whatsAppLink(invitation.destination, message)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t.sendWhatsApp}
                          </a>
                        </>
                      ) : (
                        <a
                          className="button-like"
                          href={emailLink(
                            invitation.destination,
                            t.emailSubject(props.businessName),
                            message
                          )}
                        >
                          {t.sendEmail}
                        </a>
                      );
                    })()}
                    <button
                      className="secondary"
                      type="button"
                      onClick={() =>
                        act(`staff-share-${invitation.id}`, () => copyLink(invitation))
                      }
                    >
                      {invitation.joinToken === undefined ? t.share : t.copyLink}
                    </button>
                    {confirming === `revoke-${invitation.id}` ? (
                      <>
                        <button
                          type="button"
                          disabled={isPending(`staff-revoke-${invitation.id}`)}
                          onClick={() =>
                            act(`staff-revoke-${invitation.id}`, () => revoke(invitation))
                          }
                        >
                          {t.confirmRevoke(invitation.inviteeName)}
                        </button>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => setConfirming(null)}
                        >
                          {t.cancel}
                        </button>
                      </>
                    ) : (
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => setConfirming(`revoke-${invitation.id}`)}
                      >
                        {t.revoke}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {overview.grantableRoles.length > 0 ? (
            <form onSubmit={sendInvite} aria-label={t.invite}>
              <fieldset disabled={isPending("staff-invite")}>
                <legend>{t.invite}</legend>
                <label>
                  {t.name}
                  <input
                    required
                    maxLength={120}
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <PhoneNumberField
                  label={t.phone}
                  country={country}
                  value={draft.phone}
                  onCountryChange={setCountry}
                  onValueChange={(phone) => setDraft({ ...draft, phone })}
                />
                <label>
                  {t.roleLabel}
                  <select
                    value={draft.role === "" ? overview.grantableRoles[0] : draft.role}
                    aria-describedby="staff-role-help"
                    onChange={(event) =>
                      setDraft({ ...draft, role: event.target.value as BusinessRole })
                    }
                  >
                    {overview.grantableRoles.map((role) => (
                      <option key={role} value={role}>
                        {t.role[role]}
                      </option>
                    ))}
                  </select>
                </label>
                <small id="staff-role-help">
                  {
                    t.roleHelp[
                      draft.role === "" ? (overview.grantableRoles[0] ?? "view_only") : draft.role
                    ]
                  }
                </small>
                <div className="row-actions">
                  <button type="submit">{t.send}</button>
                </div>
              </fieldset>
            </form>
          ) : null}
          {leaveControls}
        </>
      )}
    </section>
  );
}
