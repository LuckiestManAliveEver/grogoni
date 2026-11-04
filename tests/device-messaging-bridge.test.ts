// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

it("binds RPC only to the host's nonce-bearing channel and reports native failures", async () => {
  vi.resetModules();
  const meta = document.createElement("meta");
  meta.name = "grogoni-native-channel";
  meta.content = "test-per-navigation-nonce";
  document.head.append(meta);
  const { deviceMessagingAdapter } = await import("../apps/web/src/device-messaging");
  const native = {
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    postMessage: vi.fn(),
    start: vi.fn()
  };
  function offer(data: string, origin: string) {
    const event = new MessageEvent("message", { data, origin });
    Object.defineProperty(event, "ports", { value: [native] });
    window.dispatchEvent(event);
  }
  offer("grogoni-device:wrong-token", window.location.origin);
  offer("grogoni-device:test-per-navigation-nonce", "https://untrusted.example");
  expect(native.start).not.toHaveBeenCalled();
  offer("grogoni-device:test-per-navigation-nonce", window.location.origin);
  expect(native.start).toHaveBeenCalledOnce();
  const result = deviceMessagingAdapter.call("capabilities");
  await Promise.resolve();
  const sent = JSON.parse(native.postMessage.mock.calls[0]![0] as string) as {
    id: string;
    method: string;
  };
  expect(sent.method).toBe("capabilities");
  native.onmessage!(
    new MessageEvent("message", {
      data: JSON.stringify({ id: sent.id, result: { available: true } })
    })
  );
  await expect(result).resolves.toEqual({ available: true });
  const failure = deviceMessagingAdapter.call("sendSms", { recipients: ["12345"] });
  const rejected = expect(failure).rejects.toThrow("SMS role required");
  await Promise.resolve();
  const second = JSON.parse(native.postMessage.mock.calls[1]![0] as string) as { id: string };
  native.onmessage!(
    new MessageEvent("message", {
      data: JSON.stringify({ id: second.id, error: "SMS role required" })
    })
  );
  await rejected;
  meta.remove();
});
