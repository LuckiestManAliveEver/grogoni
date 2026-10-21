// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildHelpAgentPrompt } from "../apps/web/src/help-chat";
import type { ChatMessage } from "../apps/web/src/app-shell";

describe("Help agent grounding", () => {
  it("keeps the full question and recent context within the daemon limit and explains rather than executes", () => {
    const question = "Explain #sale.record without running it. ".repeat(50);
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      author: "merchant",
      body: `Earlier question ${index} `.repeat(40),
      createdAt: new Date().toISOString(),
      status: "delivered"
    }));
    const prompt = buildHelpAgentPrompt(
      "Buying, Selling, #sale.record, #receipt.confirm\n".repeat(300),
      question,
      history
    );
    expect(prompt.length).toBeLessThanOrEqual(8000);
    expect(prompt).toContain(question);
    expect(prompt).toContain("do not execute commands");
    expect(prompt).toContain("no access to private records");
    expect(prompt).toContain("Earlier question 9");
    expect(prompt).not.toContain("Earlier question 0");
  });
});
