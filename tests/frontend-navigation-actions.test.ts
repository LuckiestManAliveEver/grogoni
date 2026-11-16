import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  pathForOwnerRoute,
  pathForOwnerView,
  readOwnerRoute,
  routes
} from "../apps/web/src/routes";

describe("frontend navigation and action contracts", () => {
  it("centralizes static and encoded dynamic routes", () => {
    expect(routes.marketplace).toBe("/marketplace");
    expect(routes.sell).toBe("/sell");
    expect(routes.beta).toBe("/beta");
    expect(routes.launch).toBe("/launch");
    expect(routes.product("sugar / 1")).toBe("/products/sugar%20%2F%201");
    expect(routes.shop("grogoni.janes-shop")).toBe("/shops/grogoni.janes-shop");
    expect(routes.agent("agent@example.com")).toBe("/agents/agent%40example.com");
    expect(routes.conversation("conversation / 1", "seller")).toBe(
      "/workspace/conversations/conversation%20%2F%201"
    );
    expect(routes.storefrontProduct("shop / 1", "product / 1")).toBe(
      "/agent/shop%20%2F%201/products/product%20%2F%201"
    );
    expect(() => routes.product("  ")).toThrow("route identifier");
  });

  it("maps refresh-safe owner destinations to the correct mode and view", () => {
    expect(readOwnerRoute("/marketplace")).toEqual({ mode: "marketplace", view: "chat" });
    expect(readOwnerRoute("/sell/")).toEqual({ mode: "seller", view: "chat" });
    expect(readOwnerRoute("/catalogue")).toEqual({ mode: "seller", view: "products" });
    expect(readOwnerRoute("/workspace")).toEqual({ mode: "seller", view: "chat" });
    expect(readOwnerRoute("/sell/shop")).toEqual({
      mode: "seller",
      view: "chat",
      panel: "shop-hub"
    });
    expect(pathForOwnerRoute({ mode: "seller", view: "chat", panel: "shop-hub" })).toBe(
      "/sell/shop"
    );
    expect(readOwnerRoute("/products/product-1")).toEqual({
      mode: "seller",
      view: "products",
      productId: "product-1"
    });
    expect(readOwnerRoute("/agents/agent-1")).toEqual({
      mode: "seller",
      view: "agent",
      agentId: "agent-1"
    });
    expect(readOwnerRoute("/marketplace/conversations/conversation%201")).toEqual({
      mode: "marketplace",
      view: "chat",
      conversationId: "conversation 1"
    });
    expect(readOwnerRoute("/workspace/conversations/conversation-2")).toEqual({
      mode: "seller",
      view: "chat",
      conversationId: "conversation-2"
    });
    expect(readOwnerRoute("/beta")).toEqual({ mode: "seller", view: "beta" });
    expect(readOwnerRoute("/launch")).toEqual({ mode: "seller", view: "launch" });
    expect(readOwnerRoute("/missing")).toBeNull();
    expect(pathForOwnerView("chat", "marketplace")).toBe(routes.marketplace);
    expect(pathForOwnerView("chat", "seller")).toBe(routes.sell);
    expect(pathForOwnerView("customers", "seller")).toBe(routes.customers);
    expect(
      pathForOwnerRoute({
        mode: "marketplace",
        view: "chat",
        conversationId: "conversation-1"
      })
    ).toBe("/marketplace/conversations/conversation-1");
  });

  it("has no enabled non-submit button without an action handler", () => {
    const actionless = readFrontendFiles().flatMap((file) =>
      actionlessButtons(file, readFileSync(file, "utf8"))
    );
    expect(actionless).toEqual([]);
  });

  it("reads complete JSX attributes when disabled expressions contain comparison operators", () => {
    expect(
      actionlessButtons(
        "fixture.tsx",
        '<><button disabled={count > 0} onClick={() => save()}>Save</button><button type="submit">Submit</button><button type="button">Missing action</button></>'
      )
    ).toEqual(['fixture.tsx: <button type="button">']);
  });

  it("does not ship temporary logs, blocking alerts, placeholder links, or silent stubs", () => {
    const source = readFrontendSource();
    expect(source).not.toMatch(/console\.log|window\.alert|window\.prompt/);
    expect(source).not.toMatch(/href=["']#(?:["'])|javascript:void/);
    expect(source).not.toContain("coming soon");
    expect(source).not.toContain("not implemented yet");
  });

  it("keeps the completed audit and frontend-to-backend map in source control", () => {
    const audit = readFileSync("docs/frontend-interaction-audit.md", "utf8");
    expect(audit).toContain("| A140 |");
    expect(audit).toContain("## Frontend-to-backend action map");
    expect(audit).toContain("Account restoration");
  });
});

function readFrontendFiles(directory = "apps/web/src"): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readFrontendFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function readFrontendSource(): string {
  return readFrontendFiles()
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

function actionlessButtons(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const actionless: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(parsed) === "button"
    ) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const submit = attributes.find(
        (attribute) => attribute.name.getText(parsed) === "type"
      )?.initializer;
      const isSubmit =
        submit !== undefined &&
        ((ts.isStringLiteral(submit) && submit.text === "submit") ||
          (ts.isJsxExpression(submit) &&
            submit.expression !== undefined &&
            ts.isStringLiteral(submit.expression) &&
            submit.expression.text === "submit"));
      if (
        !isSubmit &&
        !attributes.some((attribute) => attribute.name.getText(parsed) === "onClick")
      )
        actionless.push(`${file}: ${node.getText(parsed)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return actionless;
}
