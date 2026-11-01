import { expect, test } from "@playwright/test";

for (const hasPin of [true, false]) {
  test(`recovers a device account ${hasPin ? "with" : "without"} an existing PIN`, async ({
    page
  }) => {
    const phone = "+254712345678";
    const mutations: string[] = [];
    await page.addInitScript(async () => {
      localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify"
      ]);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("grogoni-device-recovery-v1", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("credentials");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("credentials", "readwrite");
          tx.objectStore("credentials").put(
            { credentialId: "test-device", privateKey: pair.privateKey },
            "primary"
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    });
    await page.route("http://127.0.0.1:4000/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/auth/login/methods")
        return json({
          preferred: "pin",
          deviceAvailable: true,
          passwordFallback: true,
          recoveryAvailable: true,
          smsLogin: false
        });
      if (path === "/auth/pin/login")
        return json({ mfaRequired: true, transactionId: "mfa-test", factors: ["totp"] });
      if (path === "/auth/device/recover")
        return json({ account: { primaryAuthDestination: phone } });
      if (path === "/auth/credentials/status") return json({ hasPin, hasPassword: true });
      if (path === "/auth/pin/setup" || path === "/auth/pin/recover/device") {
        mutations.push(path);
        expect(route.request().postDataJSON()).toEqual({ pin: "6789", pinConfirmation: "6789" });
        return json({ code: "device_credential_recovery_required", message: "Verify again." }, 403);
      }
      if (path === "/auth/oauth/providers") return json({ providers: [] });
      return json({ code: "auth_session_expired", message: "Authentication is required." }, 401);
    });
    await page.goto("/login");
    await page.getByLabel("Phone number", { exact: true }).fill("712345678");
    await page.getByRole("button", { name: "Trouble logging in?", exact: true }).click();
    await expect(page.getByLabel("Recover with")).toBeVisible();
    await page.getByRole("button", { name: "Use account PIN", exact: true }).click();
    await page.getByLabel("4-digit PIN", { exact: true }).fill("1234");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Security check" })).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Use your account PIN" })).toBeVisible();
    await page.getByRole("button", { name: "Trouble logging in?", exact: true }).click();
    await page.getByLabel("Recover with").selectOption("email");
    await expect(page.getByLabel("Backup email", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Trouble logging in?", exact: true })
    ).toBeDisabled();
    await page.getByLabel("Recover with").selectOption("device");
    await page.getByRole("button", { name: "Trouble logging in?", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: hasPin ? "Choose a new PIN" : "Create a PIN", exact: true })
    ).toBeVisible();
    const submit = page.getByRole("button", {
      name: hasPin ? "Save new PIN" : "Create PIN",
      exact: true
    });
    await page.getByLabel("New 4-digit PIN", { exact: true }).fill("6789");
    await page.getByLabel("Confirm new PIN", { exact: true }).fill("6780");
    await expect(submit).toBeDisabled();
    await page.getByLabel("Confirm new PIN", { exact: true }).fill("6789");
    await expect(submit).toBeEnabled();
    if (hasPin) await submit.click();
    else await page.getByLabel("Confirm new PIN", { exact: true }).press("Enter");
    await expect(
      page.getByText("Verify this device again before changing your PIN.")
    ).toBeVisible();
    expect(mutations).toEqual([hasPin ? "/auth/pin/recover/device" : "/auth/pin/setup"]);
  });
}
