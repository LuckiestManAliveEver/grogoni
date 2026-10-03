// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalRegistryConnection } from "@grogoni/shared-types";

const getJson = vi.fn();
const postJson = vi.fn();
const deleteJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
  deleteJson: (...args: unknown[]) => deleteJson(...args)
}));

const { ConnectedSourcesPanel } = await import("../apps/web/src/ConnectedSourcesPanel");

function connection(
  overrides: Partial<ExternalRegistryConnection> = {}
): ExternalRegistryConnection {
  return {
    id: "conn-1",
    accountId: "account-1",
    provider: "github",
    externalAccountId: "42",
    externalUsername: "octocat",
    status: "connected",
    scopes: ["repo"],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

describe("ConnectedSourcesPanel", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    getJson.mockReset();
    postJson.mockReset();
    deleteJson.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("shows both providers as not connected when the backend reports no connections", async () => {
    getJson.mockResolvedValue({ connections: [] });
    const root = createRoot(host);
    await act(async () => root.render(<ConnectedSourcesPanel />));

    expect(getJson).toHaveBeenCalledWith("/v1/external-connections");
    expect(host.textContent).toContain("GitHub");
    expect(host.textContent).toContain("Hugging Face");
    expect(Array.from(host.querySelectorAll("strong")).map((node) => node.textContent)).toEqual([
      "Not connected",
      "Not connected"
    ]);

    await act(async () => root.unmount());
  });

  it("shows a connected provider with its username and never renders a token field", async () => {
    getJson.mockResolvedValue({ connections: [connection()] });
    const root = createRoot(host);
    await act(async () => root.render(<ConnectedSourcesPanel />));

    expect(host.textContent).toContain("Connected as octocat");
    expect(
      Array.from(host.querySelectorAll("button")).some(
        (button) => button.textContent === "Disconnect"
      )
    ).toBe(true);
    expect(host.querySelector("input[type='password']")).toBeNull();

    await act(async () => root.unmount());
  });

  it("connects GitHub by posting the pasted token and reloading from the backend", async () => {
    getJson.mockResolvedValueOnce({ connections: [] });
    getJson.mockResolvedValueOnce({ connections: [connection()] });
    postJson.mockResolvedValue(connection());

    const root = createRoot(host);
    await act(async () => root.render(<ConnectedSourcesPanel />));

    const connectButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Connect GitHub"
    )!;
    await act(async () => connectButton.click());

    const tokenInput = host.querySelector("input[type='password']") as HTMLInputElement;
    expect(tokenInput).not.toBeNull();
    await act(async () => setInputValue(tokenInput, "ghp_pasted_token"));

    const saveButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Save GitHub token"
    )!;
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    await act(async () => saveButton.click());

    expect(postJson).toHaveBeenCalledWith("/v1/external-connections/github", {
      token: "ghp_pasted_token"
    });
    expect(getJson).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Connected as octocat");
    expect(host.textContent).not.toContain("ghp_pasted_token");

    await act(async () => root.unmount());
  });

  it("disconnects by id and reloads from the backend", async () => {
    getJson.mockResolvedValueOnce({ connections: [connection()] });
    getJson.mockResolvedValueOnce({ connections: [] });
    deleteJson.mockResolvedValue({ disconnected: true, id: "conn-1" });

    const root = createRoot(host);
    await act(async () => root.render(<ConnectedSourcesPanel />));

    const disconnectButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Disconnect"
    )!;
    await act(async () => disconnectButton.click());

    expect(deleteJson).toHaveBeenCalledWith("/v1/external-connections/conn-1");
    expect(getJson).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Not connected");

    await act(async () => root.unmount());
  });

  it("surfaces the backend error message without connecting on a rejected token", async () => {
    getJson.mockResolvedValue({ connections: [] });
    postJson.mockRejectedValue(new Error("GitHub rejected this token."));

    const root = createRoot(host);
    await act(async () => root.render(<ConnectedSourcesPanel />));

    const connectButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Connect GitHub"
    )!;
    await act(async () => connectButton.click());

    const tokenInput = host.querySelector("input[type='password']") as HTMLInputElement;
    await act(async () => setInputValue(tokenInput, "bad-token"));
    const saveButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Save GitHub token"
    )!;
    await act(async () => saveButton.click());

    expect(host.textContent).toContain("GitHub rejected this token.");
    expect(getJson).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });
});

/**
 * React tracks a controlled input's previous value via a hidden property setter, so assigning
 * `input.value` directly and dispatching a plain "input" event is a no-op for onChange - the
 * usual workaround (what @testing-library/user-event and fireEvent do internally) is to invoke
 * the native HTMLInputElement value setter first, bypassing React's tracked setter.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
