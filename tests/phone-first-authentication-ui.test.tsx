// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../apps/web/src/lib/api";
import type * as ApiModule from "../apps/web/src/lib/api";

vi.mock("../apps/web/src/lib/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../apps/web/src/lib/api");
  return { ...actual, apiFetch: vi.fn() };
});

const { apiFetch } = await import("../apps/web/src/lib/api");
const { PhoneFirstAuthentication } = await import("../apps/web/src/PhoneFirstAuthentication");

const mockedApiFetch = vi.mocked(apiFetch);
const onAuthenticated = vi.fn();
const onSignUp = vi.fn();
const onForgetRemembered = vi.fn();
const onCancel = vi.fn();

let host: HTMLDivElement;
let root: Root;

function renderLogin() {
  act(() => {
    root.render(
      <PhoneFirstAuthentication
        remembered={null}
        onAuthenticated={onAuthenticated}
        onSignUp={onSignUp}
        onForgetRemembered={onForgetRemembered}
        onCancel={onCancel}
      />
    );
  });
}

function inputByLabel(label: string): HTMLInputElement {
  const labels = Array.from(document.querySelectorAll("label"));
  const match = labels.find((item) => item.textContent?.includes(label));
  const input = match?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for ${label}`);
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button ${text}`);
  return button;
}

async function change(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mockedApiFetch.mockReset();
  onAuthenticated.mockReset();
  onSignUp.mockReset();
  onForgetRemembered.mockReset();
  onCancel.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("PhoneFirstAuthentication login methods", () => {
  it("offers a direct recovery action from the main login screen", async () => {
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");

    expect(buttonByText("Trouble logging in?")).toBeInstanceOf(HTMLButtonElement);
  });

  it("keeps a failed PIN attempt on the PIN screen even when password login is available", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") {
        return {
          preferred: "pin",
          passkeyAvailable: false,
          passwordFallback: true,
          recoveryAvailable: true,
          smsLogin: false
        };
      }
      if (path === "/auth/pin/login") {
        throw new ApiRequestError(401, "The account credentials are invalid.", {
          code: "auth_credentials_invalid"
        });
      }
      throw new Error(`Unexpected request to ${path}`);
    });

    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Continue to log in"));
    await click(buttonByText("Use account PIN"));
    await change(inputByLabel("4-digit PIN"), "1234");
    await click(buttonByText("Log in"));

    expect(document.body.textContent).toContain(
      "We couldn't sign you in with that PIN. Check your account details and PIN, then try again."
    );
    expect(inputByLabel("4-digit PIN").value).toBe("1234");
    expect(document.body.textContent).not.toContain("Log in with password");
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("submits the password with Enter, the same as the Log in button", async () => {
    const requests: { path: string; body: unknown }[] = [];
    mockedApiFetch.mockImplementation(async (path, init) => {
      const body = init?.body;
      requests.push({
        path: String(path),
        body: typeof body === "string" ? JSON.parse(body) : body
      });
      if (path === "/auth/login/methods") {
        return {
          preferred: "pin",
          passkeyAvailable: false,
          passwordFallback: true,
          recoveryAvailable: false,
          smsLogin: false
        };
      }
      if (path === "/auth/login/password") {
        throw new ApiRequestError(401, "The account credentials are invalid.", {
          code: "auth_credentials_invalid"
        });
      }
      throw new Error(`Unexpected request to ${path}`);
    });

    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    // Enter in the phone field moves on, as the button does.
    await act(async () => {
      inputByLabel("Phone number").form!.requestSubmit();
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    });
    await click(buttonByText("Use a password"));
    expect(document.body.textContent).toContain("Enter the password for this account.");
    expect(document.body.textContent).not.toContain("recovery password");
    const password = inputByLabel("Password");
    await change(password, "correct horse battery");
    expect(password.form).not.toBeNull();
    await act(async () => {
      password.form!.requestSubmit();
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    });

    const login = requests.find((request) => request.path === "/auth/login/password");
    expect(login?.body).toMatchObject({ password: "correct horse battery" });
  });

  it("does not submit an empty password on Enter", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/auth/login/methods") {
        return {
          preferred: "pin",
          passkeyAvailable: false,
          passwordFallback: true,
          recoveryAvailable: false,
          smsLogin: false
        };
      }
      throw new Error(`Unexpected request to ${path}`);
    });
    renderLogin();
    await change(inputByLabel("Phone number"), "0712345678");
    await click(buttonByText("Continue to log in"));
    await click(buttonByText("Use a password"));
    await act(async () => {
      inputByLabel("Password").form!.requestSubmit();
      await Promise.resolve();
    });
    expect(mockedApiFetch.mock.calls.map(([path]) => path)).not.toContain("/auth/login/password");
  });
});
