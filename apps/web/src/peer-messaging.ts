import { PeerProvider, createPeerOutbox, type Scope, type PeerOutbox } from "@grogoni/offline-runtime";
import type { ConversationMessageSummary } from "@grogoni/shared-types";
import { WebBluetoothPeerTransport, webBluetoothSupported } from "./peer-bluetooth-transport";
import { offlineDatabase } from "./offline-runtime";
import { readCachedAuthSession } from "./auth-bootstrap";

/**
 * Optional nearby-device messaging channel (whitepaper.md, adapted to what a browser can
 * actually do - see peer-bluetooth-transport.ts). Off by default: requires the build flag below
 * AND an explicit "Connect a nearby device" user gesture each session. Never a fallback the main
 * chat pipeline reaches for silently - see docs/offline/p2p-transport-research.md for why this
 * stays a separate, disclosed surface rather than a transparent resolver provider today.
 */
export const peerMessagingEnabled = import.meta.env.VITE_PEER_MESSAGING_ENABLED === "true";

export function peerMessagingSupported(): boolean {
  return webBluetoothSupported();
}

export type NearbyConnectionStatus = "disconnected" | "connecting" | "connected";

let activeProvider: PeerProvider | null = null;
let activeTransport: WebBluetoothPeerTransport | null = null;
let status: NearbyConnectionStatus = "disconnected";
const statusListeners = new Set<(status: NearbyConnectionStatus) => void>();

function setStatus(next: NearbyConnectionStatus): void {
  status = next;
  for (const listener of statusListeners) listener(status);
}

export function nearbyConnectionStatus(): NearbyConnectionStatus {
  return status;
}

export function onNearbyStatusChange(
  handler: (status: NearbyConnectionStatus) => void
): () => void {
  statusListeners.add(handler);
  return () => {
    statusListeners.delete(handler);
  };
}

function outboxFor(scope: Scope): Promise<PeerOutbox> {
  return offlineDatabase().then((db) => createPeerOutbox(db, scope));
}

/** Lazily creates the provider for this scope. Does not connect - call connectNearbyDevice()
 *  from a click handler for that, since discover() must run inside a user gesture. */
export async function nearbyProvider(scope: Scope): Promise<PeerProvider> {
  if (activeProvider) return activeProvider;
  activeTransport = new WebBluetoothPeerTransport();
  activeProvider = new PeerProvider(activeTransport, await outboxFor(scope));
  return activeProvider;
}

/** Opens the browser's Bluetooth device picker and connects to the chosen Grogoni-compatible
 *  peripheral. Must be invoked directly from a user gesture (a click), never on page load or a
 *  timer, or the browser rejects the picker. */
export async function connectNearbyDevice(scope: Scope): Promise<void> {
  if (!peerMessagingSupported())
    throw new Error("This browser does not support Bluetooth (Web Bluetooth).");
  const provider = await nearbyProvider(scope);
  setStatus("connecting");
  try {
    const [deviceId] = await provider.discover();
    if (!deviceId) throw new Error("No nearby device was selected.");
    await provider.connect(deviceId);
    setStatus("connected");
  } catch (error) {
    setStatus("disconnected");
    throw error;
  }
}

/** Closes the Bluetooth connection but keeps the provider (and its onReceive/onDeliveryFailed
 *  subscribers, set up once when the settings panel mounts) alive, so reconnecting later reuses
 *  the same wiring instead of leaving old subscribers listening to a discarded provider. */
export function disconnectNearbyDevice(): void {
  activeTransport?.disconnectDevice();
  setStatus("disconnected");
}

/** Wraps free text in the canonical conversation envelope and hands it to the connected peer.
 *  This channel is peer-only by design (see the module docstring): it does not go through
 *  resolveProviderChain, so it never silently falls back to cloud or local delivery - if nothing
 *  is connected, this throws rather than queuing invisibly. */
export async function sendNearbyMessage(
  scope: Scope,
  text: string
): Promise<ConversationMessageSummary> {
  if (!activeProvider) throw new Error("Connect a nearby device first.");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Message is empty.");
  const accountId = readCachedAuthSession()?.account.id ?? scope.accountId;
  const now = new Date().toISOString();
  const envelope: ConversationMessageSummary = {
    id: crypto.randomUUID(),
    conversationId: `nearby:${scope.deviceId}`,
    clientMessageId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    author: "user",
    authorId: accountId,
    content: { type: "text", text: trimmed },
    clientTimestamp: now,
    createdAt: now
  };
  await activeProvider.call("conversations.message.send", envelope);
  return envelope;
}
