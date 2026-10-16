import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Logging out must stop the daemon lane (releasing its claim) while the session is still valid:
 * afterwards /release answers 401 and the task waits for its lease to lapse. The application
 * shell is too large to render in a test, so this pins the order in its source.
 */
describe("logout and the daemon lane", () => {
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
