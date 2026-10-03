import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerExecutionMetadata,
  ComputerNavigationPolicy,
  ComputerObservation,
  ComputerSession,
  ComputerTarget
} from "@grogoni/shared-types";
import { assertNavigationAllowed } from "./network-policy.js";

interface WorkerSession {
  summary: ComputerSession;
  context: BrowserContext;
  page: Page;
  policy: ComputerNavigationPolicy;
  actionLock: boolean;
}

export interface WorkerSessionInput {
  accountId: string;
  businessId: string | null;
  conversationId: string | null;
  profileId: string | null;
  executionHostId: string;
  runtimeInstanceId: string | null;
  execution: ComputerExecutionMetadata;
  storageState?: string | null;
  policy: ComputerNavigationPolicy;
}

export class PlaywrightComputerRuntime {
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, WorkerSession>();

  async createSession(input: WorkerSessionInput): Promise<ComputerSession> {
    const browser = await this.getBrowser();
    const storageState = input.storageState ? JSON.parse(input.storageState) : undefined;
    const context = await browser.newContext({
      ...(storageState === undefined ? {} : { storageState }),
      acceptDownloads: input.policy.allowDownloads,
      viewport: { width: 1280, height: 800 }
    });
    const id = randomUUID();
    const now = new Date().toISOString();
    const summary: ComputerSession = {
      id,
      profileId: input.profileId,
      accountId: input.accountId,
      businessId: input.businessId,
      conversationId: input.conversationId,
      runtimeInstanceId: input.runtimeInstanceId,
      executionHostId: input.executionHostId,
      liveViewUrl: `/v1/sessions/${id}/frame`,
      controlMode: "AGENT_CONTROLLED",
      status: "RUNNING",
      currentUrl: null,
      execution: input.execution,
      createdAt: now,
      updatedAt: now
    };
    const page = await context.newPage();
    const session: WorkerSession = {
      summary,
      context,
      page,
      policy: input.policy,
      actionLock: false
    };
    this.sessions.set(id, session);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.refreshSummary(session);
    });
    await page.route("**/*", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      try {
        await assertNavigationAllowed(route.request().url(), session.policy);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    return { ...summary };
  }

  session(id: string): ComputerSession {
    return { ...this.require(id).summary };
  }

  async navigate(action: ComputerAction): Promise<ComputerObservation> {
    const session = this.requireAgent(action.sessionId);
    const url = action.target.url;
    if (!url) throw new Error("NAVIGATION_URL_REQUIRED");
    await assertNavigationAllowed(url, session.policy);
    return this.exclusive(session, async () => {
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.refreshSummary(session);
      return this.observe(action.sessionId);
    });
  }

  async observe(sessionId: string): Promise<ComputerObservation> {
    const session = this.require(sessionId);
    const text = (
      await session.page
        .locator("body")
        .innerText({ timeout: 5_000 })
        .catch(() => "")
    )
      // Untrusted page text - deliberately strips control characters before this observation is
      // ever handed to an agent or persisted as a RuntimeHandoff artifact.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "")
      .slice(0, 40_000);
    return {
      sessionId,
      url: session.page.url() === "about:blank" ? null : session.page.url(),
      title: (await session.page.title().catch(() => "")) || null,
      text,
      screenshotRef: `/v1/sessions/${sessionId}/frame`,
      observedAt: new Date().toISOString(),
      untrustedContent: true
    };
  }

  async act(action: ComputerAction, actor: "agent" | "human"): Promise<ComputerActionResult> {
    const session =
      actor === "agent" ? this.requireAgent(action.sessionId) : this.requireHuman(action.sessionId);
    return this.exclusive(session, async () => {
      const target = this.locator(session.page, action.target);
      switch (action.kind) {
        case "click":
          if (action.target.coordinates)
            await session.page.mouse.click(
              action.target.coordinates.x,
              action.target.coordinates.y
            );
          else await target!.click({ timeout: 10_000 });
          break;
        case "type":
          if (actor === "human" && !target) await session.page.keyboard.type(action.value ?? "");
          else await target!.fill(action.value ?? "", { timeout: 10_000 });
          break;
        case "scroll":
          await session.page.mouse.wheel(0, Number(action.value ?? 600));
          break;
        case "upload":
          if (!session.policy.allowUploads) throw new Error("UPLOAD_FORBIDDEN");
          throw new Error("UPLOAD_REQUIRES_BROKERED_FILE");
        default:
          throw new Error("ACTION_UNSUPPORTED");
      }
      this.refreshSummary(session);
      return {
        sessionId: action.sessionId,
        actionId: action.id,
        status: "completed",
        observation: await this.observe(action.sessionId)
      };
    });
  }

  async frame(sessionId: string): Promise<Buffer> {
    return this.require(sessionId).page.screenshot({ type: "jpeg", quality: 70 });
  }

  takeControl(sessionId: string): ComputerSession {
    const session = this.require(sessionId);
    if (session.actionLock) throw new Error("ACTION_IN_PROGRESS");
    session.summary = {
      ...session.summary,
      controlMode: "HUMAN_CONTROLLED",
      status: "HUMAN_CONTROLLED",
      updatedAt: new Date().toISOString()
    };
    return { ...session.summary };
  }

  async releaseControl(
    sessionId: string
  ): Promise<{ session: ComputerSession; observation: ComputerObservation }> {
    const session = this.requireHuman(sessionId);
    session.summary = {
      ...session.summary,
      controlMode: "AGENT_CONTROLLED",
      status: "RESUMING",
      updatedAt: new Date().toISOString()
    };
    const observation = await this.observe(sessionId);
    session.summary = {
      ...session.summary,
      status: "RUNNING",
      updatedAt: new Date().toISOString()
    };
    return { session: { ...session.summary }, observation };
  }

  async resume(
    sessionId: string
  ): Promise<{ session: ComputerSession; observation: ComputerObservation }> {
    const session = this.require(sessionId);
    if (session.actionLock) throw new Error("ACTION_IN_PROGRESS");
    if (session.summary.controlMode !== "SUSPENDED") throw new Error("SESSION_NOT_SUSPENDED");
    session.summary = {
      ...session.summary,
      controlMode: "AGENT_CONTROLLED",
      status: "RESUMING",
      updatedAt: new Date().toISOString()
    };
    const observation = await this.observe(sessionId);
    session.summary = {
      ...session.summary,
      status: "RUNNING",
      updatedAt: new Date().toISOString()
    };
    return { session: { ...session.summary }, observation };
  }

  async storageState(sessionId: string): Promise<string> {
    return JSON.stringify(await this.require(sessionId).context.storageState());
  }

  suspend(sessionId: string): void {
    const session = this.require(sessionId);
    session.summary = {
      ...session.summary,
      controlMode: "SUSPENDED",
      status: "SUSPENDED",
      updatedAt: new Date().toISOString()
    };
  }

  async close(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    this.sessions.delete(sessionId);
    await session.context.close();
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    await this.browser?.close();
    this.browser = null;
  }

  private locator(page: Page, target: ComputerTarget) {
    if (target.selector) return page.locator(target.selector).first();
    if (target.text) return page.getByText(target.text, { exact: true }).first();
    if (target.description) return page.getByRole("button", { name: target.description }).first();
    return null;
  }

  private require(id: string): WorkerSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    return session;
  }

  private requireAgent(id: string): WorkerSession {
    const session = this.require(id);
    if (session.summary.controlMode !== "AGENT_CONTROLLED")
      throw new Error("AGENT_CONTROL_REJECTED");
    return session;
  }

  private requireHuman(id: string): WorkerSession {
    const session = this.require(id);
    if (session.summary.controlMode !== "HUMAN_CONTROLLED")
      throw new Error("HUMAN_CONTROL_REJECTED");
    return session;
  }

  private async exclusive<T>(session: WorkerSession, operation: () => Promise<T>): Promise<T> {
    if (session.actionLock) throw new Error("CONCURRENT_ACTION_REJECTED");
    session.actionLock = true;
    try {
      return await operation();
    } finally {
      session.actionLock = false;
    }
  }

  private refreshSummary(session: WorkerSession): void {
    session.summary = {
      ...session.summary,
      currentUrl: session.page.url() === "about:blank" ? null : session.page.url(),
      updatedAt: new Date().toISOString()
    };
  }

  private async getBrowser(): Promise<Browser> {
    this.browser ??= await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-first-run"]
    });
    return this.browser;
  }
}
