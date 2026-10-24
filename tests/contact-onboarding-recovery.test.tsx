// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdentityNetworkOnboardingCard } from "../apps/web/src/IdentityNetworkOnboardingCard";
import type { ContactsAccessAdapter } from "../apps/web/src/contacts-access";
let container: HTMLDivElement, root: Root;
const sync = vi.fn();
const adapter: ContactsAccessAdapter = {
  source: "native",
  isSupported: () => true,
  select: vi.fn(async () => [{ name: ["B"], tel: ["+442079460552"] }])
};
const session = {
  account: { id: "account-onboarding", primaryAuthChannel: "phone" },
  user: { id: "user-onboarding" }
} as Parameters<typeof IdentityNetworkOnboardingCard>[0]["session"];
function view(supported = true) {
  return (
    <IdentityNetworkOnboardingCard
      session={session}
      graph={null}
      oauthProviders={[]}
      oauthProvidersLoaded
      onGoogleContacts={vi.fn()}
      onPhoneContactsSync={sync}
      contactsAdapter={{ ...adapter, isSupported: () => supported }}
    />
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("uses the injected adapter only after an action and reports failed sync honestly", async () => {
  sync.mockResolvedValue(null);
  await act(async () => root.render(view()));
  expect(adapter.select).not.toHaveBeenCalled();
  await act(async () =>
    (container.querySelector(".identity-network-actions button") as HTMLButtonElement).click()
  );
  expect(adapter.select).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Contacts could not be synced");
  expect(container.textContent).not.toContain("contact added.");
});
it("offers vCard/CSV import when the picker is unsupported and syncs its contents", async () => {
  sync.mockResolvedValue({ syncedContactNodeIds: ["node-b"] });
  await act(async () => root.render(view(false)));
  expect(container.textContent).not.toContain("Choose phonebook contacts");
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([], "contacts.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", {
    value: async () => "Name,Phone,Email\nB,+442079460552,b@example.invalid"
  });
  Object.defineProperty(input, "files", { value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(sync).toHaveBeenCalledWith([expect.objectContaining({ name: ["B"] })]);
  expect(container.textContent).toContain("1 phonebook contact added.");
});
it("persists Not now per account across remounts", async () => {
  await act(async () => root.render(view()));
  await act(async () =>
    (container.querySelector(".identity-network-dismiss") as HTMLButtonElement).click()
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(view()));
  expect(container.querySelector(".identity-network-onboarding")).toBeNull();
});
