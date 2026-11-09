/**
 * The state of a business's WhatsApp Linked Devices connection, as the connector
 * (services/api/src/messaging/whatsapp-linked/connector.ts) moves it and GET
 * /businesses/:businessId/channels/whatsapp-linked reports it.
 *
 *   DISCONNECTED → PAIRING (code shown) → CONNECTING → CONNECTED
 *   CONNECTED → RECONNECTING → CONNECTED, or ERROR after repeated failures
 *   any live state → AUTH_REQUIRED | REVOKED (WhatsApp ended the link) | SUSPENDED | ERROR
 *
 * The connector's socket events drive these moves, so the connector's `transition()` is where they
 * happen; this module names the states and the groups both sides read.
 */
export type WhatsAppLinkedState =
  | "DISCONNECTED"
  | "PAIRING"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "AUTH_REQUIRED"
  | "REVOKED"
  | "SUSPENDED"
  | "ERROR";

/** Linking is under way: the owner waits for WhatsApp, and the setup form stays out of the way. */
export const whatsAppLinkInProgressStates = [
  "PAIRING",
  "CONNECTING",
  "RECONNECTING"
] as const satisfies readonly WhatsAppLinkedState[];

export function isWhatsAppLinkInProgress(state: string): boolean {
  return (whatsAppLinkInProgressStates as readonly string[]).includes(state);
}
