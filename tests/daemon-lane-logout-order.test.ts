import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Logging out must stop the daemon lane (releasing its claim) while the session is still valid:
 * afterwards /release answers 401 and the task waits for its lease to lapse. The application
 * shell is too large to render in a test, so this pins the order in its source.
 */
describe("logout and the daemon lane", () => {
  it("requires a session and permits device-only identities only in Help", () => {
    const file = "apps/web/src/GrogoniApplication.tsx";
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    let argument: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText() === "useDaemonLane")
        argument = node.arguments[0];
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(argument && ts.isConditionalExpression(argument)).toBe(true);
    if (!argument || !ts.isConditionalExpression(argument))
      throw new Error("Missing session guard.");
    const expression = argument.getText();
    for (const [session, isSignedOut, helpTopic, expected] of [
      [null, true, undefined, null],
      [{ account: { id: "owner" } }, false, undefined, "owner"],
      [{ account: { id: "visitor" } }, true, undefined, null],
      [{ account: { id: "visitor" } }, true, "tools", "visitor"]
    ] as const) {
      expect(
        runInNewContext(expression, {
          session,
          isSignedOut,
          activeConversation: { conversation: { helpTopic } }
        })
      ).toBe(expected);
    }
  });

  it("awaits stopDaemonLane before calling the logout endpoint", () => {
    const file = "apps/web/src/GrogoniApplication.tsx";
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    let body: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "logout")
        body = node.body?.getText();
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(body).toBeDefined();
    const stop = body!.indexOf("await stopDaemonLane()");
    const logout = body!.search(/"\/auth\/logout(-all)?"/u);
    expect(stop).toBeGreaterThan(-1);
    expect(logout).toBeGreaterThan(stop);
  });
});
