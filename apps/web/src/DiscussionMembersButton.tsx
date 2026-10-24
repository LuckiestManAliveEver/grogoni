import type { ConversationParticipantSummary } from "@grogoni/shared-types";
export function DiscussionMembersButton({
  participants,
  onOpen
}: {
  participants: ConversationParticipantSummary[];
  onOpen: () => void;
}) {
  if (participants.filter((participant) => participant.role === "account").length < 2) return null;
  return (
    <button className="discussion-members" type="button" onClick={onOpen}>
      {participants
        .filter((participant) => participant.role !== "shop")
        .map((participant) => participant.displayName ?? participant.role)
        .join(", ")}
    </button>
  );
}
