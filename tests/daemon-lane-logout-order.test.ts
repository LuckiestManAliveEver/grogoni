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
  it("runs for every cookie-backed account, including a guest device account", () => {
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
    if (!argument) throw new Error("Missing daemon lane call.");
    const expression = argument.getText();
    for (const [session, expected] of [
      [null, null],
      [{ account: { id: "owner", identityLevel: "strong" } }, "owner"],
      [{ account: { id: "guest", identityLevel: "device" } }, "guest"]
    ] as const) {
      expect(runInNewContext(expression, { session })).toBe(expected);
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
