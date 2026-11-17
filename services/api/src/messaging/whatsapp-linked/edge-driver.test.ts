import { expect, it, vi } from "vitest";
import { baileysLinkedDriver } from "./edge-driver.js";

it("refuses Edge socket hosting without reading credentials or invoking connector callbacks", async () => {
  const save = vi.fn();
  const state = vi.fn();
  const inbound = vi.fn();
  await expect(
    baileysLinkedDriver.open({ auth: null, save, state, inbound })
  ).rejects.toMatchObject({ statusCode: 503, code: "whatsapp_linked_host_required" });
  expect(save).not.toHaveBeenCalled();
  expect(state).not.toHaveBeenCalled();
  expect(inbound).not.toHaveBeenCalled();
});
