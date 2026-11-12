import { describe, expect, it } from "vitest";
import {
  getEffectiveInteractiveBudgetMs,
  getEffectivePersistenceDeadlineMs,
  normalizePriorityCommand
} from "../services/api/src/app";

describe("priority optimization budget", () => {
  it("treats priority and optimize as optimized mode", () => {
    expect(normalizePriorityCommand("priority")).toBe("optimized");
    expect(normalizePriorityCommand("optimize")).toBe("optimized");
    expect(normalizePriorityCommand("optimized")).toBe("optimized");
    expect(normalizePriorityCommand("balanced")).toBe("balanced");
    expect(normalizePriorityCommand("normal")).toBe("balanced");
  });

  it("applies the tightened budgets in optimized mode", () => {
    const previous = process.env.PRIORITY_COMMAND;
    try {
      process.env.PRIORITY_COMMAND = "priority";
      expect(getEffectiveInteractiveBudgetMs()).toBe(100);
      expect(getEffectivePersistenceDeadlineMs()).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.PRIORITY_COMMAND;
      else process.env.PRIORITY_COMMAND = previous;
    }
  });

  it("keeps the balanced budget when the command is not optimized", () => {
    const previous = process.env.PRIORITY_COMMAND;
    try {
      process.env.PRIORITY_COMMAND = "balanced";
      expect(getEffectiveInteractiveBudgetMs()).toBe(150);
      expect(getEffectivePersistenceDeadlineMs()).toBe(600);
    } finally {
      if (previous === undefined) delete process.env.PRIORITY_COMMAND;
      else process.env.PRIORITY_COMMAND = previous;
    }
  });
});
