import { describe, expect, it } from "vitest";
import { renderRuntimeModelOutputInstructions } from "../packages/tool-core/src/parsers/runtime-proposal-prompting";
import { procurementRuntimeTools } from "../packages/tool-core/src/domains/procurement";

describe("procurement model input contracts", () => {
  it("renders the actual task-only preparation contract without supplying task answers", () => {
    const instructions = renderRuntimeModelOutputInstructions(["procurement.prepare"]);
    expect(instructions).toContain(
      JSON.stringify(procurementRuntimeTools["procurement.prepare"].inputSchema)
    );
    expect(instructions).toContain("Include only these input properties");
    expect(instructions).not.toMatch(/\b(?:beans|rice)\b/);
    expect(instructions).not.toContain("Tool procurement.quote.record:");
  });

  it("does not expose procurement contracts when those tools are not allowed", () => {
    expect(renderRuntimeModelOutputInstructions(["products.list"])).not.toContain(
      "Input contract:"
    );
  });

  it("uses the existing quote schema when quote entry is permitted", () => {
    const instructions = renderRuntimeModelOutputInstructions(["procurement.quote.record"]);
    expect(instructions).toContain(
      JSON.stringify(procurementRuntimeTools["procurement.quote.record"].inputSchema)
    );
    expect(instructions).not.toContain("Tool procurement.prepare:");
  });
});
