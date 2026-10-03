import type { PeerTransport } from "@grogoni/offline-runtime";

/**
 * Grogoni's nearby-messaging GATT layout. A device advertising this service is a Grogoni-compatible
 * peer: the RX characteristic is where it notifies frames it wants to send us, the TX
 * characteristic is where we write frames for it to receive. Any future native peripheral
 * (Android BLE, a companion device) must expose this same service/characteristic layout to be
 * reachable from here.
 */
export const GROGONI_NEARBY_SERVICE_UUID = "6c9b7a00-9d2e-4f3a-8b1c-2f6a5e9d0a01";
export const GROGONI_NEARBY_TX_CHARACTERISTIC_UUID = "6c9b7a01-9d2e-4f3a-8b1c-2f6a5e9d0a01";
export const GROGONI_NEARBY_RX_CHARACTERISTIC_UUID = "6c9b7a02-9d2e-4f3a-8b1c-2f6a5e9d0a01";

/**
 * A safe, conservative frame size for `writeValueWithoutResponse`. The Web Bluetooth API does
 * not expose the negotiated ATT MTU to page script, so this stays well under the smallest
 * default (23-byte ATT MTU, 20 bytes of usable payload) plus headroom most stacks negotiate up
 * to in practice, rather than assuming the larger end of the range and risking silent truncation
 * on a peer that never renegotiated.
 */
const CONSERVATIVE_BLE_MTU = 100;

export function webBluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator && !!navigator.bluetooth;
}

/**
 * PeerTransport backed by Web Bluetooth. Browsers only expose the GATT *central* role to page
 * script - there is no API for a web page to advertise or act as a peripheral - so this can only
 * ever connect outward to one explicitly user-picked Grogoni-compatible BLE peripheral at a time.
 * It cannot discover or link two browser tabs to each other, and it never scans in the
 * background: every connection starts from `discover()`, which must run inside a user gesture
 * and opens the browser's own device chooser. This is the real ceiling of the platform, not a
 * simplification - see docs/offline/p2p-transport-research.md.
 */
export class WebBluetoothPeerTransport implements PeerTransport {
  readonly mtu = CONSERVATIVE_BLE_MTU;
  private device: BluetoothDevice | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private handlers = new Set<(frame: Uint8Array) => void>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly bluetooth: Bluetooth | undefined = navigator.bluetooth) {}

  async available(): Promise<boolean> {
    if (!this.bluetooth) return false;
    try {
      return (await this.bluetooth.getAvailability()) && this.tx !== null && this.rx !== null;
    } catch {
      return false;
    }
  }

  /** Opens the browser's own device picker scoped to Grogoni-compatible peripherals. Must be
   *  called from a user gesture (a click), or the browser rejects it. Returns the chosen
   *  device's id, which is stable for `connect()` only as long as the browser still remembers
   *  the grant (Chrome persists it; some browsers drop it on restart). */
  async discover(): Promise<string[]> {
    if (!this.bluetooth) throw new Error("This browser does not support Web Bluetooth.");
    const device = await this.bluetooth.requestDevice({
      filters: [{ services: [GROGONI_NEARBY_SERVICE_UUID] }]
    });
    return [device.id];
  }

  async connect(deviceId: string): Promise<void> {
    if (!this.bluetooth) throw new Error("This browser does not support Web Bluetooth.");
    const known = (await this.bluetooth.getDevices?.()) ?? [];
    const device = known.find((candidate) => candidate.id === deviceId);
    if (!device)
      throw new Error(
        "Pick the nearby device again - this browser did not keep Bluetooth permission for it."
      );
    this.teardown();
    const server = await device.gatt?.connect();
    if (!server) throw new Error("Could not open a Bluetooth connection to that device.");
    const service = await server.getPrimaryService(GROGONI_NEARBY_SERVICE_UUID);
    const [tx, rx] = await Promise.all([
      service.getCharacteristic(GROGONI_NEARBY_TX_CHARACTERISTIC_UUID),
      service.getCharacteristic(GROGONI_NEARBY_RX_CHARACTERISTIC_UUID)
    ]);
    await rx.startNotifications();
    rx.addEventListener("characteristicvaluechanged", this.handleNotification);
    device.addEventListener("gattserverdisconnected", this.handleDisconnect);
    this.device = device;
    this.tx = tx;
    this.rx = rx;
  }

  async broadcast(frame: Uint8Array): Promise<void> {
    if (!this.tx) throw new Error("Not connected to a nearby device.");
    // Copy just this view's bytes - `frame.buffer` may be a larger backing buffer than the
    // frame itself when the caller handed us a subarray.
    const bytes = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength
    ) as ArrayBuffer;
    const write = this.writeTail.then(async () => {
      const characteristic = this.tx;
      if (!characteristic) throw new Error("Not connected to a nearby device.");
      await characteristic.writeValueWithoutResponse(bytes);
    });
    // BLE stacks commonly reject overlapping writes. Keep the queue usable after one failure,
    // while returning that failure to the caller so its durable outbox can retry later.
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  subscribe(handler: (frame: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Closes the Bluetooth connection only, keeping frame subscribers registered so a later
   *  connect() (to the same or a different device) keeps delivering to them. Use this for a
   *  user-initiated "Disconnect" that may be followed by reconnecting. */
  disconnectDevice(): void {
    this.teardown();
  }

  /** Full teardown, including frame subscribers - only for when this transport itself is being
   *  discarded (e.g. the owning PeerProvider is being closed), not for an ordinary disconnect. */
  close(): void {
    this.teardown();
    this.handlers.clear();
  }

  private handleNotification = (event: Event): void => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic;
    const value = characteristic.value;
    if (!value) return;
    const frame = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (const handler of this.handlers) handler(frame);
  };

  private handleDisconnect = (): void => {
    this.tx = null;
    this.rx = null;
  };

  private teardown(): void {
    this.rx?.removeEventListener("characteristicvaluechanged", this.handleNotification);
    this.device?.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
    this.tx = null;
    this.rx = null;
  }
}
