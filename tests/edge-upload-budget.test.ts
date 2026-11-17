import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  checkEdgeUploadBudget,
  edgeApiUploadFiles,
  edgeUploadBudgetBytes
} from "../scripts/edge-api-upload.mjs";
import {
  edgeBundleBanner,
  pdfWorkerSpecifier,
  serverResponseBodyDefault
} from "../scripts/edge-bundle-banner.mjs";

const root = new URL("../", import.meta.url);

// The same guard light-my-request 6.8.1 added to Response#write.
function lightMyRequest681Write(this: { _hasBody?: boolean; chunks: string[] }, data: string) {
  if (!this._hasBody) return true;
  this.chunks.push(data);
  return true;
}

function denoLikeServerResponse() {
  // Deno's node:http ServerResponse: no _hasBody set by the constructor.
  class ServerResponse {
    chunks: string[] = [];
    write = lightMyRequest681Write;
  }
  return ServerResponse;
}

describe("Edge ServerResponse body default", () => {
  it("drops the body without the default, which was the production outage", () => {
    const Response = denoLikeServerResponse();
    const response = new Response();
    response.write('{"ok":true}');
    expect(response.chunks).toEqual([]);
  });

  it("keeps bodies once the banner default is installed", () => {
    const Response = denoLikeServerResponse();
    new Function("EdgeServerResponse", serverResponseBodyDefault)(Response);
    const response = new Response();
    response.write('{"ok":true}');
    expect(response.chunks).toEqual(['{"ok":true}']);
  });

  it("leaves an explicit per-response false (HEAD/204/304) in force", () => {
    const Response = denoLikeServerResponse();
    new Function("EdgeServerResponse", serverResponseBodyDefault)(Response);
    const response = Object.assign(new Response(), { _hasBody: false });
    response.write("ignored");
    expect(response.chunks).toEqual([]);
  });

  it("does not override a runtime that already defines _hasBody", () => {
    class NodeLike {}
    Object.defineProperty(NodeLike.prototype, "_hasBody", { value: false, writable: true });
    new Function("EdgeServerResponse", serverResponseBodyDefault)(NodeLike);
    expect((NodeLike.prototype as { _hasBody: boolean })._hasBody).toBe(false);
  });
});

describe("Edge bundle banner", () => {
  const pdfjsVersion = (() => {
    const apiRequire = createRequire(new URL("services/api/package.json", root));
    const pdfRequire = createRequire(apiRequire.resolve("pdf-parse"));
    return JSON.parse(readFileSync(pdfRequire.resolve("pdfjs-dist/package.json"), "utf8"))
      .version as string;
  })();

  it("pins the pdf.js worker to the release pdf-parse bundles", () => {
    expect(pdfWorkerSpecifier(pdfjsVersion)).toBe("./pdf-worker.mjs");
    expect(() => pdfWorkerSpecifier("^5.4.0")).toThrow(/Unexpected pdfjs-dist version/);
  });

  it("loads the worker lazily through a literal import and installs the body default", () => {
    const banner = edgeBundleBanner(pdfjsVersion);
    expect(banner).toContain(`globalThis.__edgeLoadPdfWorker = () => import("./pdf-worker.mjs");`);
    expect(banner).toContain(serverResponseBodyDefault);
    expect(banner).not.toMatch(/import \{[^}]*\} from "npm:pdfjs-dist/);
    expect(banner).not.toContain("npm:pdfjs-dist@");
  });
});

describe("Edge upload file set and budget", () => {
  it("uploads every tracked Edge source plus the generated bundle, and nothing else", () => {
    const tracked = execFileSync("git", ["ls-files", "supabase/functions/api"], {
      cwd: root,
      encoding: "utf8"
    })
      .trim()
      .split("\n")
      .map((path) => path.slice("supabase/functions/api/".length));
    expect([...edgeApiUploadFiles].sort()).toEqual(
      [...tracked, "domain-bundle.mjs", "pdf-worker.mjs"].sort()
    );
    expect(edgeApiUploadFiles).toContain("pdf-worker.mjs");
  });

  it("passes at the budget and fails one byte over it", () => {
    expect(checkEdgeUploadBudget({ "a.ts": edgeUploadBudgetBytes }).ok).toBe(true);
    const over = checkEdgeUploadBudget({ "a.ts": edgeUploadBudgetBytes - 10, "b.mjs": 11 });
    expect(over.ok).toBe(false);
    expect(over.totalBytes).toBe(edgeUploadBudgetBytes + 1);
    expect(over.message).toContain("b.mjs 11");
  });

  it("accepts the locally bundled worker within the nominal deployment budget", () => {
    expect(
      checkEdgeUploadBudget({
        "domain-bundle.mjs": 3_624_385,
        "pdf-worker.mjs": 1_043_521,
        rest: 123_487
      }).ok
    ).toBe(true);
  });
});
