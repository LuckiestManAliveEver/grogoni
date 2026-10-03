// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  WebBluetoothPeerTransport,
  GROGONI_NEARBY_SERVICE_UUID,
  GROGONI_NEARBY_TX_CHARACTERISTIC_UUID,
  GROGONI_NEARBY_RX_CHARACTERISTIC_UUID,
  webBluetoothSupported
} from "../apps/web/src/peer-bluetooth-transport";

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  writes: Uint8Array[] = [];
  activeWrites = 0;
  maxConcurrentWrites = 0;
  writeGate: Promise<void> | null = null;
  async startNotifications(): Promise<this> {
    return this;
  }
  async writeValueWithoutResponse(data: ArrayBuffer): Promise<void> {
    this.activeWrites++;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.activeWrites);
    this.writes.push(new Uint8Array(data));
    await this.writeGate;
    this.activeWrites--;
  }
  emit(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class FakeService {
  characteristics = new Map<string, FakeCharacteristic>([
    [GROGONI_NEARBY_TX_CHARACTERISTIC_UUID, new FakeCharacteristic()],
    [GROGONI_NEARBY_RX_CHARACTERISTIC_UUID, new FakeCharacteristic()]
  ]);
  async getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
    const characteristic = this.characteristics.get(uuid);
    if (!characteristic) throw new Error("Unknown characteristic.");
    return characteristic;
  }
}

class FakeServer {
  connected = false;
  service = new FakeService();
  async connect(): Promise<this> {
    this.connected = true;
    return this;
  }
  disconnect(): void {
    this.connected = false;
  }
  async getPrimaryService(uuid: string): Promise<FakeService> {
    if (uuid !== GROGONI_NEARBY_SERVICE_UUID) throw new Error("Unknown service.");
    return this.service;
  }
}

class FakeDevice extends EventTarget {
  gatt = new FakeServer();
  constructor(public id: string) {
    super();
  }
}

function fakeBluetooth(device: FakeDevice) {
  return {
    getAvailability: vi.fn(async () => true),
    requestDevice: vi.fn(async () => device as unknown as BluetoothDevice),
    getDevices: vi.fn(async () => [device as unknown as BluetoothDevice])
  } as unknown as Bluetooth;
}

describe("WebBluetoothPeerTransport", () => {
  it("reports unsupported when the browser exposes no Web Bluetooth API", () => {
    expect(webBluetoothSupported()).toBe(false);
  });

  it("discovers through the browser's own device picker, scoped to the Grogoni service", async () => {
    const device = new FakeDevice("device-1");
    const bluetooth = fakeBluetooth(device);
    const transport = new WebBluetoothPeerTransport(bluetooth);
    await expect(transport.discover()).resolves.toEqual(["device-1"]);
    expect(bluetooth.requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [GROGONI_NEARBY_SERVICE_UUID] }]
    });
  });

  it("refuses to connect to a device id the browser never granted permission for", async () => {
    const device = new FakeDevice("device-1");
    const transport = new WebBluetoothPeerTransport(fakeBluetooth(device));
    await expect(transport.connect("some-other-device")).rejects.toThrow(
      /pick the nearby device again/i
    );
  });

  it("connects, exchanges frames in both directions, and stops working after a disconnect", async () => {
    const device = new FakeDevice("device-1");
    const transport = new WebBluetoothPeerTransport(fakeBluetooth(device));
    expect(await transport.available()).toBe(false);

    await transport.connect("device-1");
    expect(await transport.available()).toBe(true);

    const received: Uint8Array[] = [];
    const unsubscribe = transport.subscribe((frame) => received.push(frame));
    device.gatt.service.characteristics
      .get(GROGONI_NEARBY_RX_CHARACTERISTIC_UUID)!
      .emit(new Uint8Array([1, 2, 3]));
    expect(received).toHaveLength(1);
    expect([...received[0]!]).toEqual([1, 2, 3]);

    await transport.broadcast(new Uint8Array([9, 8, 7]));
    const tx = device.gatt.service.characteristics.get(GROGONI_NEARBY_TX_CHARACTERISTIC_UUID)!;
    expect(tx.writes).toHaveLength(1);
    expect([...tx.writes[0]!]).toEqual([9, 8, 7]);

    device.dispatchEvent(new Event("gattserverdisconnected"));
    await expect(transport.broadcast(new Uint8Array([1]))).rejects.toThrow(/not connected/i);

    unsubscribe();
    transport.close();
  });

  it("keeps frame subscribers wired across disconnectDevice() and a later reconnect", async () => {
    const device = new FakeDevice("device-1");
    const transport = new WebBluetoothPeerTransport(fakeBluetooth(device));
    const received: Uint8Array[] = [];
    transport.subscribe((frame) => received.push(frame));

    await transport.connect("device-1");
    device.gatt.service.characteristics
      .get(GROGONI_NEARBY_RX_CHARACTERISTIC_UUID)!
      .emit(new Uint8Array([1]));
    expect(received).toHaveLength(1);

    transport.disconnectDevice();
    expect(await transport.available()).toBe(false);
    await expect(transport.broadcast(new Uint8Array([1]))).rejects.toThrow(/not connected/i);

    await transport.connect("device-1");
    expect(await transport.available()).toBe(true);
    device.gatt.service.characteristics
      .get(GROGONI_NEARBY_RX_CHARACTERISTIC_UUID)!
      .emit(new Uint8Array([2]));
    expect(received).toHaveLength(2);
    expect([...received[1]!]).toEqual([2]);
  });

  it("only writes the frame's own bytes when broadcasting a subarray view", async () => {
    const device = new FakeDevice("device-1");
    const transport = new WebBluetoothPeerTransport(fakeBluetooth(device));
    await transport.connect("device-1");
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = backing.subarray(2, 4);
    await transport.broadcast(view);
    const tx = device.gatt.service.characteristics.get(GROGONI_NEARBY_TX_CHARACTERISTIC_UUID)!;
    expect([...tx.writes[0]!]).toEqual([3, 4]);
  });

  it("serializes writes so the BLE stack never receives overlapping operations", async () => {
    const device = new FakeDevice("device-1");
    const transport = new WebBluetoothPeerTransport(fakeBluetooth(device));
    await transport.connect("device-1");
    const tx = device.gatt.service.characteristics.get(GROGONI_NEARBY_TX_CHARACTERISTIC_UUID)!;
    let release!: () => void;
    tx.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = transport.broadcast(new Uint8Array([1]));
    const second = transport.broadcast(new Uint8Array([2]));
    await Promise.resolve();
    await Promise.resolve();
    expect(tx.writes).toHaveLength(1);
    expect(tx.maxConcurrentWrites).toBe(1);

    release();
    await Promise.all([first, second]);
    expect(tx.writes.map((write) => [...write])).toEqual([[1], [2]]);
    expect(tx.maxConcurrentWrites).toBe(1);
  });
});
