import { describe, expect, it } from "vitest";

import { classifyComputerAction, validateRuntimeToolInput } from "../packages/tool-core/src";

describe("computer runtime policy", () => {
  it("classifies navigation and observation as read actions", () => {
    expect(
      classifyComputerAction({
        toolName: "computer.navigate",
        actionInput: { sessionId: "browser-session", url: "https://example.com" }
      })
    ).toMatchObject({ risk: "READ", requiresApproval: false });

    expect(
      classifyComputerAction({
        toolName: "computer.observe",
        actionInput: { sessionId: "session-1" }
      })
    ).toMatchObject({ risk: "READ", requiresApproval: false });
  });

  it("classifies generic typing as mutation without final approval", () => {
    expect(
      classifyComputerAction({
        toolName: "computer.type",
        actionInput: { sessionId: "session-1", text: "draft only" }
      })
    ).toMatchObject({ risk: "MUTATE", requiresApproval: false });
  });

  it("requires approval for consequential semantics even when the raw action is a click", () => {
    expect(
      classifyComputerAction({
        toolName: "computer.click",
        actionInput: {
          sessionId: "session-1",
          selector: "button[type=submit]",
          semanticIntent: "submit order for 20 bags"
        }
      })
    ).toMatchObject({ risk: "CONSEQUENTIAL", requiresApproval: true });
  });

  it("binds approvals to the exact proposed action hash", () => {
    const approved = classifyComputerAction({
      toolName: "computer.click",
      actionInput: {
        sessionId: "session-1",
        selector: "button[type=submit]",
        semanticIntent: "send message to Kamau"
      }
    });
    const changed = classifyComputerAction({
      toolName: "computer.click",
      actionInput: {
        sessionId: "session-1",
        selector: "button[type=submit]",
        semanticIntent: "send message to Amina"
      }
    });

    expect(approved.actionHash).not.toBe(changed.actionHash);
  });

  it("validates navigation protocols before provider execution", () => {
    expect(
      validateRuntimeToolInput("computer.navigate", {
        sessionId: "browser-session",
        url: "https://example.com"
      }).ok
    ).toBe(true);
    expect(
      validateRuntimeToolInput("computer.navigate", {
        sessionId: "browser-session",
        url: "file:///etc/passwd"
      }).ok
    ).toBe(false);
  });
});
