/** The same application talks to a capability adapter; browsers never simulate telephony. */
export interface DeviceCapabilities {
  available: boolean;
  roleGranted: boolean;
  ready: boolean;
  subscriptionId: number | null;
  syncEnabled: boolean;
  businessId: string | null;
  accountId: string | null;
  errorCode?: string | null;
}
export interface DeviceMessage {
  id: number;
  address: string;
  body: string;
  date: number;
  type: number;
  read: boolean;
}
export interface DeviceMms {
  id: number;
  date: number;
  type: number;
  box: number;
  subscriptionId: number;
  addresses: string[];
}
export interface DeviceAttachment {
  id: string;
  name: string;
  type: string;
}
export interface DeviceCallOptions {
  /** Defaults to 120 s. Flows that wait on several Android dialogs pass a longer budget. */
  timeoutMs?: number;
}
export interface DeviceMessagingAdapter {
  call<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: DeviceCallOptions
  ): Promise<T>;
}
export function isNativeDeviceHost(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector('meta[name="grogoni-native-channel"]') !== null
  );
}

let port: MessagePort | null = null;
let nextId = 0;
const waiting = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let resolveReady: (() => void) | null = null;
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});
if (typeof window !== "undefined")
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="grogoni-native-channel"]'
    )?.content;
    // The host transfers this port only to its pinned main frame. A per-navigation nonce prevents
    // another frame from substituting a port, including frames whose browser origin is opaque.
    if (
      !token ||
      event.data !== `grogoni-device:${token}` ||
      event.ports.length !== 1 ||
      port !== null
    )
      return;
    if (event.origin && event.origin !== window.location.origin) return;
    port = event.ports[0]!;
    port.onmessage = (reply: MessageEvent<string>) => {
      let message: { id: string; result?: unknown; error?: string };
      try {
        message = JSON.parse(reply.data) as typeof message;
      } catch {
        return;
      }
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    };
    port.start();
    resolveReady?.();
  });

export const deviceMessagingAdapter: DeviceMessagingAdapter = {
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: DeviceCallOptions = {}
  ): Promise<T> {
    if (!isNativeDeviceHost()) {
      if (method === "capabilities")
        return {
          available: false,
          roleGranted: false,
          ready: false,
          subscriptionId: null,
          syncEnabled: false,
          businessId: null,
          accountId: null
        } as T;
      throw new Error("Carrier messages require the installed Android app.");
    }
    if (port === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The device adapter did not start. Reopen the app.")),
          10_000
        );
        void ready.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    const id = String(++nextId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(
          new Error(
            options.timeoutMs === undefined
              ? "The device operation timed out. Check message status before retrying a send."
              : "Android did not answer in time. Close any open Android prompt and try again."
          )
        );
      }, options.timeoutMs ?? 120_000);
      waiting.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        port!.postMessage(JSON.stringify({ id, method, params }));
      } catch (error) {
        waiting.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
};

export function smsStatus(type: number): string {
  return (
    (
      { 1: "Received", 2: "Sent", 3: "Draft", 4: "Pending", 5: "Failed", 6: "Queued" } as Record<
        number,
        string
      >
    )[type] ?? "Unknown"
  );
}
export function mmsStatus(message: DeviceMms): string {
  if (message.type === 130) return "Download pending";
  return (
    ({ 1: "Received", 2: "Sent", 3: "Draft or failed", 4: "Pending" } as Record<number, string>)[
      message.box
    ] ?? "Unknown"
  );
}

export function newDeviceCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
