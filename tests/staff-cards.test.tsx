// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MyStaffInvitationSummary,
  StaffInvitationSummary,
  StaffOverviewSummary
} from "@grogoni/shared-types";

const fetchFreshJson = vi.fn();
const postJson = vi.fn();
const patchJson = vi.fn();
const deleteJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  fetchFreshJson: (...args: unknown[]) => fetchFreshJson(...args),
  getJson: (...args: unknown[]) => fetchFreshJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
  patchJson: (...args: unknown[]) => patchJson(...args),
  deleteJson: (...args: unknown[]) => deleteJson(...args)
}));

const { default: StaffCard } = await import("../apps/web/src/StaffCard");
const { default: StaffInvitationsPrompt } = await import("../apps/web/src/StaffInvitationsPrompt");
const { staffCopy } = await import("../apps/web/src/staff-copy");
const { default: ShellNotices } = await import("../apps/web/src/ShellNotices");
const { ApiRequestError } = await import("../apps/web/src/lib/api");

const t = staffCopy("en");
const base = "/businesses/shop-a/staff";
const at = new Date("2026-10-01T00:00:00Z").toISOString();

const overview: StaffOverviewSummary = {
  businessId: "shop-a",
  grantableRoles: ["manager", "sales_agent", "cashier", "driver", "view_only"],
  invitations: [
    {
      id: "inv-1",
      businessId: "shop-a",
      role: "driver",
      inviteeName: "Otieno",
      channel: "phone",
      destination: "+254711000111",
      status: "pending",
      invitedByUserId: "owner",
      createdAt: at,
      expiresAt: at,
      respondedAt: null,
      acceptedByUserId: null,
      membershipId: null,
      needsReinvite: false,
      joinToken: "secret-token-abcdefghijkl"
    }
  ],
  members: [
    {
      membershipId: "m-owner",
      userId: "owner",
      displayName: "Julien",
      phone: "+254700000001",
      role: "owner",
      isYou: true,
      manageable: false
    },
    {
      membershipId: "m-wanjiru",
      userId: "wanjiru",
      displayName: "Wanjiru",
      phone: "+254722000222",
      role: "sales_agent",
      isYou: false,
      manageable: true
    }
  ]
};

async function flush() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (found === undefined) throw new Error(`No button "${label}"`);
  return found;
}

async function type(control: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype =
      control instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })
    );
  });
}

describe("staff cards", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    for (const mock of [fetchFreshJson, postJson, patchJson, deleteJson]) mock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root = createRoot(host);
      root.render(node);
    });
    await flush();
  }

  it("lists members and waiting invitations, with controls only where the server allows", async () => {
    fetchFreshJson.mockResolvedValue(overview);
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    const text = host.textContent ?? "";
    expect(text).toContain(`Julien (${t.you})`);
    expect(text).toContain(`Wanjiru · +254722000222 · ${t.role.sales_agent}`);
    expect(text).toContain(`Otieno · +254711000111 · ${t.role.driver}`);
    // Only Wanjiru is manageable: one role select and one Remove.
    expect(host.querySelectorAll(".staff-members select")).toHaveLength(1);
    expect(
      [...host.querySelectorAll("button")].filter((item) => item.textContent === t.remove)
    ).toHaveLength(1);
    expect(text).not.toContain(t.leave);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("invites by phone with the country, and shows how to reach the invitee", async () => {
    fetchFreshJson.mockResolvedValue({ ...overview, invitations: [] });
    const created: StaffInvitationSummary = {
      ...overview.invitations[0]!,
      id: "inv-2",
      inviteeName: "Achieng",
      destination: "+254712345678",
      role: "sales_agent"
    };
    postJson.mockResolvedValue(created);
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    const form = host.querySelector(`form[aria-label="${t.invite}"]`) as HTMLFormElement;
    const [nameInput] = [...form.querySelectorAll("input")].filter(
      (item) => item.maxLength === 120
    );
    await type(nameInput as HTMLInputElement, "Achieng");
    const phoneInput = form.querySelector(
      'input[type="tel"], input[inputmode="tel"]'
    ) as HTMLInputElement;
    await type(phoneInput, "0712345678");
    const roleSelect = [...form.querySelectorAll("select")].at(-1) as HTMLSelectElement;
    await type(roleSelect, "sales_agent");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/invitations`, {
      name: "Achieng",
      phone: "0712345678",
      country: expect.any(String),
      role: "sales_agent"
    });
    expect(host.textContent).toContain(t.invited("Achieng", "+254712345678", "phone"));
    expect(host.textContent).toContain("Achieng · +254712345678");
  });

  it("changes a role, and removes only after a confirming second tap", async () => {
    fetchFreshJson.mockResolvedValue(overview);
    patchJson.mockResolvedValue({ ...overview.members[1], role: "driver" });
    deleteJson.mockResolvedValue({ removed: true });
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    await type(host.querySelector(".staff-members select") as HTMLSelectElement, "driver");
    await flush();
    expect(patchJson).toHaveBeenCalledWith(`${base}/members/m-wanjiru`, { role: "driver" });
    expect(host.textContent).toContain(`Wanjiru · +254722000222 · ${t.role.driver}`);

    await act(async () => button(host, t.remove).click());
    expect(deleteJson).not.toHaveBeenCalled();
    await act(async () => button(host, t.confirmRemove("Wanjiru")).click());
    await flush();
    expect(deleteJson).toHaveBeenCalledWith(`${base}/members/m-wanjiru`);
    expect(host.textContent).not.toContain("Wanjiru");
  });

  it("tells the owner when an invitation must be sent again", async () => {
    fetchFreshJson.mockResolvedValue({
      ...overview,
      invitations: [{ ...overview.invitations[0]!, needsReinvite: true }]
    });
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    expect(host.textContent).toContain(t.needsReinvite);
  });

  it("sends the invitation straight to the invited number by SMS or WhatsApp", async () => {
    fetchFreshJson.mockResolvedValue(overview);
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    const link = `${window.location.origin}/?staffInvite=inv-1&t=secret-token-abcdefghijkl`;
    const text = t.shareText("Shop A", t.role.driver, link);
    const sms = [...host.querySelectorAll("a")].find((item) => item.textContent === t.sendSms);
    const whatsapp = [...host.querySelectorAll("a")].find(
      (item) => item.textContent === t.sendWhatsApp
    );
    expect(sms?.getAttribute("href")).toBe(`sms:+254711000111?&body=${encodeURIComponent(text)}`);
    expect(whatsapp?.getAttribute("href")).toBe(
      `https://wa.me/254711000111?text=${encodeURIComponent(text)}`
    );
    expect(whatsapp?.getAttribute("rel")).toContain("noopener");
  });

  it("marks members who joined through the link", async () => {
    fetchFreshJson.mockResolvedValue({
      ...overview,
      members: overview.members.map((member) =>
        member.userId === "wanjiru" ? { ...member, confirmedByLink: true } : member
      )
    });
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    expect(host.textContent).toContain(
      `Wanjiru · +254722000222 · ${t.role.sales_agent} · ${t.confirmedByLink}`
    );
  });

  it("sends the link's secret when accepting the invitation it was opened for", async () => {
    window.localStorage.setItem(
      "grogoni.staffInvite.pending",
      JSON.stringify({ invitationId: "inv-1", joinToken: "secret-xyz", savedAt: Date.now() })
    );
    fetchFreshJson.mockResolvedValue({
      invitations: [
        {
          id: "inv-1",
          businessId: "shop-a",
          businessName: "Shop A",
          role: "driver",
          invitedByName: "Julien",
          expiresAt: at
        }
      ]
    });
    postJson.mockResolvedValue({
      invitation: {},
      business: { id: "shop-a", name: "Shop A", language: "en", grogoniId: "grogoni.shop-a" },
      membership: { id: "m1", businessId: "shop-a", userId: "me", role: "driver" }
    });
    await render(<StaffInvitationsPrompt accountId="me" onJoined={vi.fn()} />);
    await act(async () => button(host, t.accept).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith("/v1/staff-invitations/inv-1/accept", {
      joinToken: "secret-xyz"
    });
    expect(window.localStorage.getItem("grogoni.staffInvite.pending")).toBeNull();
  });

  it("says so when the link was sent to a different number", async () => {
    window.localStorage.setItem(
      "grogoni.staffInvite.pending",
      JSON.stringify({ invitationId: "inv-elsewhere", joinToken: "x", savedAt: Date.now() })
    );
    fetchFreshJson.mockResolvedValue({ invitations: [] });
    await render(<StaffInvitationsPrompt accountId="me" onJoined={vi.fn()} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.joinLinkNotForYou);
    await act(async () => button(host, t.dismiss).click());
    expect(window.localStorage.getItem("grogoni.staffInvite.pending")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("asks a signed-out visitor who opened a link to sign up or log in", async () => {
    window.localStorage.setItem(
      "grogoni.staffInvite.pending",
      JSON.stringify({ invitationId: "inv-1", joinToken: "x", savedAt: Date.now() })
    );
    await render(
      <ShellNotices
        statusMessage=""
        working={false}
        accountId={null}
        signedOut={true}
        onJoinedShop={vi.fn()}
      />
    );
    expect(host.textContent).toContain(t.joinBanner);
    const hrefOf = (label: string) =>
      [...host.querySelectorAll("a")]
        .find((item) => item.textContent === label)
        ?.getAttribute("href");
    // Both paths: someone who already has an account logs in, a new person signs up.
    expect(hrefOf(t.joinBannerSignUp)).toBe("/signup");
    expect(hrefOf(t.joinBannerLogIn)).toBe("/login");
    window.localStorage.removeItem("grogoni.staffInvite.pending");
  });

  it("sends an email invitation by email, worded for email", async () => {
    const emailInvite = {
      ...overview.invitations[0]!,
      id: "inv-mail",
      channel: "email" as const,
      destination: "rider@example.com",
      joinToken: "mail-secret"
    };
    fetchFreshJson.mockResolvedValue({ ...overview, invitations: [emailInvite] });
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    const link = `${window.location.origin}/?staffInvite=inv-mail&t=mail-secret`;
    const mail = [...host.querySelectorAll("a")].find((item) => item.textContent === t.sendEmail);
    expect(mail?.getAttribute("href")).toBe(
      `mailto:rider@example.com?subject=${encodeURIComponent(t.emailSubject("Shop A"))}&body=${encodeURIComponent(
        t.shareText("Shop A", t.role.driver, link, "email")
      )}`
    );
    expect(t.shareText("Shop A", t.role.driver, link, "email")).toContain("email address");
    expect([...host.querySelectorAll("a")].some((item) => item.textContent === t.sendSms)).toBe(
      false
    );
  });

  it("keeps a way to re-send an older invitation that has no link", async () => {
    const legacy = { ...overview.invitations[0]!, joinToken: undefined };
    fetchFreshJson.mockResolvedValue({ ...overview, invitations: [legacy] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    await act(async () => button(host, t.share).click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(t.shareTextWithoutLink("Shop A", t.role.driver));
    expect(host.textContent).toContain(t.copied);
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("revokes a waiting invitation", async () => {
    fetchFreshJson.mockResolvedValue(overview);
    postJson.mockResolvedValue({});
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    await act(async () => button(host, t.revoke).click());
    // First tap only asks; nothing is revoked yet.
    expect(postJson).not.toHaveBeenCalled();
    await act(async () => button(host, t.confirmRevoke("Otieno")).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/invitations/inv-1/revoke`, {});
    expect(host.textContent).toContain(t.noPending);
  });

  it("offers staff who cannot manage people only a confirmed Leave", async () => {
    fetchFreshJson.mockRejectedValue(new ApiRequestError(403, "Permission denied."));
    postJson.mockResolvedValue({ left: true });
    const onLeft = vi.fn();
    await render(
      <StaffCard businessId="shop-a" businessName="Shop A" viewerRole="driver" onLeft={onLeft} />
    );
    expect(host.textContent).not.toContain(t.invite);
    await act(async () => button(host, t.leave).click());
    expect(postJson).not.toHaveBeenCalled();
    await act(async () => button(host, t.confirmLeave).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith(`${base}/leave`, {});
    expect(onLeft).toHaveBeenCalled();
  });

  it("renders nothing for an owner the server refuses (never offers the owner Leave)", async () => {
    fetchFreshJson.mockRejectedValue(new ApiRequestError(403, "Permission denied."));
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    expect(host.textContent).toBe("");
  });

  it("lets an invitee accept, then hands the joined shop to the app", async () => {
    const invitation: MyStaffInvitationSummary = {
      id: "inv-1",
      businessId: "shop-a",
      businessName: "Shop A",
      role: "driver",
      invitedByName: "Julien",
      expiresAt: at
    };
    fetchFreshJson.mockResolvedValue({ invitations: [invitation] });
    const shop = {
      business: { id: "shop-a", name: "Shop A", language: "en", grogoniId: "grogoni.shop-a" },
      membership: { id: "m1", businessId: "shop-a", userId: "me", role: "driver" }
    };
    postJson.mockResolvedValue({ invitation: {}, ...shop });
    const onJoined = vi.fn();
    await render(<StaffInvitationsPrompt accountId="me" onJoined={onJoined} />);
    expect(host.textContent).toContain(t.invitationFrom("Shop A", t.role.driver, "Julien"));
    expect(postJson).not.toHaveBeenCalled();
    await act(async () => button(host, t.accept).click());
    await flush();
    expect(postJson).toHaveBeenCalledWith("/v1/staff-invitations/inv-1/accept", {});
    expect(onJoined).toHaveBeenCalledWith(shop);
    expect(host.textContent).toContain(t.joined("Shop A"));
    expect(host.textContent).not.toContain(t.accept);
  });

  it("declines, shows errors as alerts, and renders nothing when there is nothing to answer", async () => {
    const invitation: MyStaffInvitationSummary = {
      id: "inv-9",
      businessId: "shop-b",
      businessName: "Shop B",
      role: "cashier",
      invitedByName: "",
      expiresAt: at
    };
    fetchFreshJson.mockResolvedValue({ invitations: [invitation] });
    postJson.mockRejectedValueOnce(new Error("This invitation has expired."));
    await render(<StaffInvitationsPrompt accountId="me" onJoined={vi.fn()} />);
    expect(host.textContent).toContain(t.invitationFrom("Shop B", t.role.cashier, ""));
    await act(async () => button(host, t.accept).click());
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("expired");
    postJson.mockResolvedValueOnce({ declined: true });
    await act(async () => button(host, t.decline).click());
    await flush();
    expect(postJson).toHaveBeenLastCalledWith("/v1/staff-invitations/inv-9/decline", {});
    expect(host.textContent).not.toContain("Shop B");

    act(() => root.unmount());
    fetchFreshJson.mockResolvedValue({ invitations: [] });
    await render(<StaffInvitationsPrompt accountId="me" onJoined={vi.fn()} />);
    expect(host.textContent).toBe("");
  });

  it("shows the status line and asks for invitations only for a signed-in account", async () => {
    fetchFreshJson.mockResolvedValue({ invitations: [] });
    await render(
      <ShellNotices
        statusMessage="Saved product."
        working={false}
        accountId={null}
        onJoinedShop={vi.fn()}
      />
    );
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Saved product.");
    expect(fetchFreshJson).not.toHaveBeenCalled();
    act(() => root.unmount());
    await render(
      <ShellNotices
        statusMessage=""
        working={false}
        accountId="acct-1"
        signedOut={false}
        onJoinedShop={vi.fn()}
      />
    );
    expect(host.querySelector(".app-action-notice")).toBeNull();
    expect(fetchFreshJson).toHaveBeenCalledWith("/v1/staff-invitations");
  });

  it("checks again for invitations when the app comes back into view", async () => {
    fetchFreshJson.mockResolvedValue({ invitations: [] });
    await render(<StaffInvitationsPrompt accountId="me" onJoined={vi.fn()} />);
    expect(fetchFreshJson).toHaveBeenCalledTimes(1);
    fetchFreshJson.mockResolvedValue({
      invitations: [
        {
          id: "inv-new",
          businessId: "shop-c",
          businessName: "Shop C",
          role: "driver",
          invitedByName: "Amina",
          expiresAt: at
        }
      ]
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(fetchFreshJson).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(t.invitationFrom("Shop C", t.role.driver, "Amina"));
  });

  it("treats closing the share sheet as a choice, not an error", async () => {
    fetchFreshJson.mockResolvedValue(overview);
    const share = vi.fn().mockRejectedValue(new DOMException("closed", "AbortError"));
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await render(<StaffCard businessId="shop-a" businessName="Shop A" viewerRole="owner" />);
    await act(async () => button(host, t.copyLink).click());
    await flush();
    expect(share).toHaveBeenCalledWith({
      text: t.shareText(
        "Shop A",
        t.role.driver,
        `${window.location.origin}/?staffInvite=inv-1&t=secret-token-abcdefghijkl`
      )
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    Reflect.deleteProperty(navigator, "share");
  });

  it("ships Swahili for every string and mounts in the app shell and business settings", () => {
    const sw = staffCopy("sw");
    expect(Object.keys(sw).sort()).toEqual(Object.keys(t).sort());
    expect(Object.keys(sw.role).sort()).toEqual(Object.keys(t.role).sort());
    expect(sw.accept).not.toBe(t.accept);
    expect(readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8")).toContain("<ShellNotices");
    expect(readFileSync("apps/web/src/ShellNotices.tsx", "utf8")).toContain(
      "<StaffInvitationsPrompt"
    );
    expect(readFileSync("apps/web/src/AgentProfileSurface.tsx", "utf8")).toContain("<StaffCard");
  });
});
