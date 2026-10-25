import { describe, expect, it } from "vitest";
import {
  parseRuntimeHashtagInvocation,
  runtimeHashtagCapabilities,
  runtimeHashtagQuery,
  runtimeToolRegistry,
  type RuntimeToolName
} from "../packages/tool-core/src";

describe("runtime hashtag capabilities", () => {
  it("projects every canonical runtime capability into the chat picker", () => {
    const toolNames = Object.keys(runtimeToolRegistry) as RuntimeToolName[];
    expect(runtimeHashtagCapabilities.map((capability) => capability.toolName)).toEqual(toolNames);
    expect(runtimeHashtagCapabilities.map((capability) => capability.hashtag)).toEqual(
      toolNames.map((toolName) => `#${toolName}`)
    );
  });

  it("routes every exact # capability name without model interpretation", () => {
    for (const toolName of Object.keys(runtimeToolRegistry) as RuntimeToolName[]) {
      expect(parseRuntimeHashtagInvocation(`#${toolName} {}`)).toMatchObject({
        command: toolName,
        toolName,
        proposal: { toolName, input: {} }
      });
    }
  });

  it("supports empty, plain-query, single-string, and structured JSON inputs", () => {
    expect(parseRuntimeHashtagInvocation("#reports.summary")).toMatchObject({
      proposal: { toolName: "reports.summary", input: {}, validation: { ok: true } }
    });
    expect(parseRuntimeHashtagInvocation("#products.list sugar")).toMatchObject({
      proposal: { toolName: "products.list", input: { query: "sugar" } }
    });
    expect(parseRuntimeHashtagInvocation("#product.delete Sugar")).toMatchObject({
      proposal: {
        toolName: "product.delete",
        input: { productName: "Sugar" },
        validation: { ok: true }
      }
    });
    expect(
      parseRuntimeHashtagInvocation('#product.create {"name":"Sugar","unit":"kg","quantity":5}')
    ).toMatchObject({
      proposal: {
        toolName: "product.create",
        input: { name: "Sugar", unit: "kg", quantity: 5 },
        validation: { ok: true }
      }
    });
  });

  it("returns safe clarification proposals for unknown commands and bad input", () => {
    expect(parseRuntimeHashtagInvocation("#constructor")).toMatchObject({
      toolName: null,
      proposal: { toolName: "unknown.clarify", validation: { ok: false } }
    });
    expect(parseRuntimeHashtagInvocation("#not.a.tool")).toMatchObject({
      toolName: null,
      proposal: { toolName: "unknown.clarify", validation: { ok: false } }
    });
    expect(parseRuntimeHashtagInvocation("#product.create {oops")).toMatchObject({
      proposal: { toolName: "product.create", validation: { ok: false } }
    });
    expect(parseRuntimeHashtagInvocation("Please check #products.list")).toBeNull();
  });

  it("asks for computer session prerequisites before calling a provider", () => {
    for (const name of Object.keys(runtimeToolRegistry).filter(
      (name) => name.startsWith("computer.") && name !== "computer.session.create"
    )) {
      expect(parseRuntimeHashtagInvocation(`#${name} {}`)?.proposal.validation).toMatchObject({
        ok: false,
        errors: [expect.stringContaining("computer session")]
      });
    }
  });

  it("extracts a picker query only while a leading command is being typed", () => {
    expect(runtimeHashtagQuery("#")).toBe("");
    expect(runtimeHashtagQuery(" #product.")).toBe("product.");
    expect(runtimeHashtagQuery("#product.create ")).toBeNull();
  });
});
