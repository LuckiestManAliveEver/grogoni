import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
const sharedModule = readFileSync("apps/web/src/grogoni-application-shared.ts", "utf8");
const agentProfileSurface = readFileSync("apps/web/src/AgentProfileSurface.tsx", "utf8");
const identitySecurityPanel = readFileSync("apps/web/src/IdentitySecurityPanel.tsx", "utf8");
const agentPolicyPanels = readFileSync("apps/web/src/AgentPolicyPanels.tsx", "utf8");
const agentRuntimeAccessPanel = readFileSync("apps/web/src/AgentRuntimeAccessPanel.tsx", "utf8");
const agentRetentionPanel = readFileSync("apps/web/src/AgentRetentionPanel.tsx", "utf8");
const productCapture = readFileSync("apps/web/src/ProductCapturePanel.tsx", "utf8");
const accountControls = readFileSync("apps/web/src/AccountBackendControls.tsx", "utf8");
const phoneSignup = readFileSync("apps/web/src/PhoneSignup.tsx", "utf8");
const phoneLogin = readFileSync("apps/web/src/PhoneFirstAuthentication.tsx", "utf8");

describe("frontend coverage for backend-owned lifecycles", () => {
  it("renders the staged backend signup transaction as a dedicated frontend flow, requiring a password", () => {
    expect(sharedModule).toContain('import("./PhoneSignup")');
    expect(application).toContain("<PhoneSignup");
    expect(phoneSignup).toContain('"/auth/signup/start"');
    expect(phoneSignup).toContain('"/auth/signup/complete"');
    expect(phoneSignup).toContain("Display name");
    expect(phoneSignup).toContain("password.length < 10");
    expect(phoneSignup).toContain("termsAccepted");
    expect(phoneSignup).toContain("privacyAccepted");
    expect(phoneSignup).toContain('"/auth/passkeys/register/options"');
    expect(phoneSignup).toContain('"/auth/passkeys/register/verify"');
    expect(phoneSignup).toContain("createdSession !== null");
    expect(phoneSignup).not.toContain("addPassword");
  });

  it("uses backend method discovery and presents PIN-primary return access, passkey fallback-only", () => {
    expect(phoneLogin).toContain('"/auth/login/methods"');
    expect(phoneLogin).toContain("loginMethods?.passwordFallback");
    expect(phoneLogin).toContain("loginMethods?.recoveryAvailable");
    expect(phoneLogin).toContain("Use account PIN");
    expect(phoneLogin).not.toContain("Continue with a passkey");
    expect(phoneLogin).not.toContain("legacy");
    expect(phoneLogin).not.toContain('"/auth/identify"');
  });

  it("completes the camera catalogue capture lifecycle", () => {
    expect(sharedModule).toContain('import("./ProductCapturePanel")');
    expect(productCapture).toContain("function ProductCapturePanel");
    expect(productCapture).toContain('capture="environment"');
    expect(productCapture).toContain("/product-captures`");
    expect(productCapture).toContain("/product-captures/${encodeURIComponent(job.id)}/retry");
    expect(productCapture).toContain("/product-captures/${encodeURIComponent(job.id)}/review");
    expect(productCapture).toContain("/product-captures/${encodeURIComponent(job.id)}/confirm");
    expect(productCapture).toContain("/product-captures/${encodeURIComponent(job.id)}/cancel");
    expect(productCapture).toContain("Your unfinished photo capture was restored.");
    expect(productCapture).toContain("Show this photo in the public catalogue");
  });

  it("lets owners update the account name exposed by the backend", () => {
    expect(sharedModule).toContain('import("./AccountBackendControls")');
    expect(accountControls).toContain('"/account/display-name"');
    expect(accountControls).toContain('aria-label="Account display name"');
    expect(identitySecurityPanel).toContain("onOwnerUserChange({ ...ownerUser, displayName })");
  });

  it("lets an existing account create and change its PIN and password", () => {
    expect(identitySecurityPanel).toContain('"/auth/credentials/status"');
    expect(identitySecurityPanel).toContain('"/auth/pin/setup"');
    expect(identitySecurityPanel).toContain('"/auth/pin/change"');
    expect(identitySecurityPanel).toContain('"/auth/password/setup"');
    expect(identitySecurityPanel).toContain('"/auth/password/change"');
    expect(identitySecurityPanel).toContain('aria-label="Account login PIN"');
    expect(identitySecurityPanel).toContain('credentialStatus?.hasPassword ? "Change password"');
  });

  it("lists and revokes inactive end-to-end encryption keys", () => {
    expect(accountControls).toContain(
      'apiFetch<{ devices: E2eeDeviceSummary[] }>("/v1/e2ee/devices")'
    );
    expect(accountControls).toContain("/v1/e2ee/devices/${encodeURIComponent(deviceId)}");
    expect(accountControls).toContain('aria-label="Messaging encryption keys"');
    expect(accountControls).toContain(
      'disabled={isCurrent || isPending("encryption-device-revoke")}'
    );
  });

  it("uses structured backend agent controls instead of editable compatibility fields", () => {
    expect(agentPolicyPanels).toContain("draftAgent.personalityConfig.tone");
    expect(agentPolicyPanels).toContain("draftAgent.instructionPolicy.maximumDiscountPercent");
    expect(agentRuntimeAccessPanel).toContain("draftAgent.skillBindings.map");
    expect(agentRetentionPanel).toContain("draftAgent.memoryPolicy.ownerCorrectionsEnabled");
    expect(agentProfileSurface).not.toContain("Compatibility fields");
    expect(agentProfileSurface).not.toContain("Advanced knowledge and integration labels");
    expect(agentProfileSurface).not.toContain("value={draftAgent.tools.join");
    expect(agentProfileSurface).not.toContain("value={draftAgent.integrations.join");
  });
});
