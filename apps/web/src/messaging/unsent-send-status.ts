/**
 * Status lines for a send that stopped before anything left the device. The message goes back to
 * the composer (useChatRuntimeState's returnUnsentMessage), so each one says the draft is kept.
 */
export const unsentSendStatus = {
  noDeviceSession:
    "Couldn't start a device session, so the message was not sent. Your draft is saved; try again.",
  runtimeHandoff: "Wait for the runtime handoff to finish, then send again. Your draft is saved.",
  attachmentsOffline: "Reading chat attachments needs a connection to Luna. Your draft is saved."
} as const;
