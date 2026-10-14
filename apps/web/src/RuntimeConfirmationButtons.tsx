export function RuntimeConfirmationButtons({
  token,
  pending,
  onConfirm,
  onReject
}: {
  token: string;
  pending: boolean;
  onConfirm: (token: string) => void;
  onReject: ((token: string) => void) | undefined;
}) {
  return (
    <div className="button-row">
      <button type="button" onClick={() => onConfirm(token)} disabled={pending} aria-busy={pending}>
        {pending ? "Confirming..." : "Confirm"}
      </button>
      {onReject && (
        <button type="button" disabled={pending} onClick={() => onReject(token)}>
          Reject
        </button>
      )}
    </div>
  );
}
