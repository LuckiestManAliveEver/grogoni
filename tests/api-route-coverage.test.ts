import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  businessRouteGroup,
  edgeOnlyRoutes,
  reachableEdgeRoutes,
  extractAndroidCalls,
  extractWebCalls,
  findRoute,
  routeMatches,
  resolveModule
} from "../scripts/check-api-route-coverage";

const D = "\u0000";
const directory = mkdtempSync(path.join(tmpdir(), "route-coverage-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function webFixture(source: string) {
  const file = path.join(directory, `fixture-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  return extractWebCalls([file], routes);
}

const routes = [
  { method: "POST", path: "/auth/identity/merge/pin" },
  { method: "GET", path: "/businesses/:businessId/documents" },
  { method: "POST", path: "/businesses/:businessId/documents/extract" },
  { method: "GET", path: "/businesses/:businessId/fulfillment/settings" },
  { method: "PATCH", path: "/businesses/:businessId/imports/:importJobId/rows/:rowNumber" },
  { method: "GET", path: "/v1/conversations" }
];

describe("route matching", () => {
  it("matches parameters, and lets a whole dynamic segment stand for a fixed word", () => {
    expect(
      routeMatches(
        "/businesses/:businessId/documents/extract",
        `/businesses/${D}/documents/extract`
      )
    ).toBe(true);
    expect(
      routeMatches(
        "/businesses/:businessId/imports/:importJobId/rows/:rowNumber",
        `/businesses/${D}/imports/${D}/${D}/${D}`
      )
    ).toBe(true);
    expect(
      routeMatches("/businesses/:businessId/documents/extract", `/businesses/${D}/documents/ocr`)
    ).toBe(false);
  });

  it("does not let a partly dynamic segment fill a fixed word", () => {
    expect(routeMatches("/v1/conversations", `/v${D}/conversations`)).toBe(false);
  });

  it("matches path bases as prefixes and `${base}/tail` paths as suffixes", () => {
    expect(
      routeMatches(
        "/businesses/:businessId/fulfillment/settings",
        `/businesses/${D}/fulfillment`,
        false,
        true
      )
    ).toBe(true);
    expect(routeMatches("/businesses/:businessId/fulfillment/settings", "/settings", true)).toBe(
      true
    );
    expect(routeMatches("/businesses/:businessId/fulfillment/settings", "/vehicles", true)).toBe(
      false
    );
  });

  it("reports a missing route and a wrong method separately", () => {
    expect(
      findRoute(routes, {
        file: "a",
        line: 1,
        path: `/businesses/${D}/documents/ocr`,
        suffixOnly: false
      }).status
    ).toBe("missing");
    expect(
      findRoute(routes, {
        file: "a",
        line: 1,
        path: "/v1/conversations",
        method: "DELETE",
        suffixOnly: false
      })
    ).toEqual({ status: "method_mismatch", methods: ["GET"] });
    expect(
      findRoute(routes, {
        file: "a",
        line: 1,
        path: "/v1/conversations",
        method: "GET",
        suffixOnly: false
      }).status
    ).toBe("ok");
  });
});

describe("web client call extraction", () => {
  it("finds calls with the method their helper or options state", () => {
    const calls = webFixture(`
      postJson(\`/businesses/\${id}/documents/ocr\`, body);
      apiFetch("/v1/conversations", { method: "DELETE" });
      apiFetch("/v1/conversations");
      postJson("/auth/identity/merge/pin", { method: "phone" });
    `);
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", `/businesses/${D}/documents/ocr`],
      ["DELETE", "/v1/conversations"],
      ["GET", "/v1/conversations"],
      ["POST", "/auth/identity/merge/pin"]
    ]);
  });

  it("ignores path tests, static assets and unrelated paths", () => {
    const calls = webFixture(`
      if (pathname.startsWith("/auth/signup/") || pathname === "/auth/continue") {}
      const manifest = \`\${enginePath}/manifest.json\`;
      navigate("/terms");
    `);
    expect(calls).toEqual([]);
  });

  it("checks cache keys as prefixes and resolves bases where they are used", () => {
    const calls = webFixture(`
      const path = \`/businesses/\${id}/fulfillment\`;
      const revision = useApiMutationRevision(\`/businesses/\${id}\`);
      getJson(\`\${path}/settings\`);
    `);
    // A base declaration is checked as a prefix, and again through the getJson that extends it.
    expect(calls.map((call) => [call.path, Boolean(call.prefixOnly), call.suffixOnly])).toEqual([
      [`/businesses/${D}/fulfillment`, true, false],
      [`/businesses/${D}`, true, false],
      [`/businesses/${D}/fulfillment/settings`, false, false]
    ]);
  });
});

describe("Android client call extraction", () => {
  it("reads Kotlin paths, templates and the request() method", () => {
    const file = path.join(directory, "Client.kt");
    writeFileSync(
      file,
      [
        "private fun request(method: String, path: String, body: Any? = null) = Unit",
        'val a = request("POST", "/auth/pin/login", body)',
        "val b = request(",
        '    "POST",',
        '    "/v1/devices/native-sms/commands/$commandId/acknowledge",',
        ")"
      ].join("\n")
    );
    expect(extractAndroidCalls([file]).map((call) => [call.method, call.path])).toEqual([
      ["POST", "/auth/pin/login"],
      ["POST", `/v1/devices/native-sms/commands/${D}/acknowledge`]
    ]);
  });
});

// The cases an adversarial review used to slip broken calls past the first version of the check
// (/tmp/api-route-completeness/critique/round-1.md, defect 5). Each must be reported.
describe("broken calls the check must not miss", () => {
  it.each([
    ["an unknown base", "postJson(`${businessUrl}/documents/ocr`, {});"],
    ["string concatenation", 'postJson("/businesses/" + id + "/documents/ocr", {});'],
    ["a first segment no route uses", "postJson(`/inventory-sync/${id}`, {});"],
    ["a typo in the first segment", "apiFetch(`/buisnesses/${id}/documents/extract`);"],
    ["a literal word inside a template", 'postJson(`/businesses/${id}/${"documents"}/ocr`, {});'],
    [
      "a fetch against the API base",
      'fetch(`${readApiBaseUrl()}/inventory-sync/run`, { method: "POST" });'
    ],
    ["a fetch against an API base variable", "fetch(`${apiBaseUrl}/inventory-sync`);"],
    [
      "one branch of a ternary",
      'postJson(flag ? "/documents/ocr" : "/auth/identity/merge/pin", {});'
    ],
    ["a beacon to the API", 'navigator.sendBeacon(`${readApiBaseUrl()}/telemetry/bogus`, "x");'],
    ["a URL built on the API base", 'fetch(new URL("/documents/ocr", readApiBaseUrl()));'],
    [
      "a wrong method held in a const",
      'const method = "DELETE";\napiFetch(`/businesses/${id}/documents/extract`, { method });'
    ],
    [
      "a path builder function",
      "const ocrPath = (id: string) => `/documents/${id}/ocr`;\npostJson(ocrPath(id), {});"
    ],
    [
      "a path constant passed by name",
      'const OCR_PATH = "/documents/ocr";\npostJson(OCR_PATH, {});'
    ],
    [
      "a path in an endpoints object",
      'const endpoints = { ocr: "/documents/ocr" };\npostJson(endpoints.ocr, {});'
    ],
    [
      "an array joined with slashes",
      'postJson(["", "businesses", id, "documents", "ocr"].join("/"), {});'
    ],
    [
      "a wrong method in an options variable",
      'const init = { method: "PUT" };\napiFetch(`/businesses/${id}/documents/extract`, init);'
    ],
    [
      "a bad tail on a base declared in the file",
      "const p = `/businesses/${id}/documents`;\npostJson(`${p}/ocrx`, {});"
    ]
  ])("reports %s", (_label, source) => {
    const calls = webFixture(source);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => findRoute(routes, call).status !== "ok")).toBe(true);
  });

  it("reports broken Kotlin calls, concatenated or outside the usual prefixes", () => {
    const file = path.join(directory, "Broken.kt");
    writeFileSync(
      file,
      [
        "private fun request(method: String, path: String) = Unit",
        'request("POST", "/businesses/" + id + "/documents/ocr")',
        'request("POST", "/mcp/bogus")',
        'request("POST", "$base/documents/ocr")',
        'URL("${BuildConfig.GROGONI_API_ORIGIN}/auth/session/refreshed")'
      ].join("\n")
    );
    const calls = extractAndroidCalls([file]);
    expect(calls.map((call) => [call.path, call.suffixOnly])).toEqual([
      [`/businesses/${D}/documents/ocr`, false],
      ["/mcp/bogus", false],
      ["/documents/ocr", true],
      ["/auth/session/refreshed", false]
    ]);
    expect(calls.every((call) => findRoute(routes, call).status === "missing")).toBe(true);
  });

  it("still accepts the real shapes those rules must not break", () => {
    const calls = webFixture(
      "const p = `/businesses/${id}/documents`;\npostJson(`${p}/extract`, {});\napiFetch(`${readApiBaseUrl()}/v1/conversations`);"
    );
    expect(calls.map((call) => findRoute(routes, call).status)).toEqual(["ok", "ok", "ok"]);
  });
});

describe("paths declared in another file", () => {
  it("resolves imported path constants and builder functions", () => {
    const paths = path.join(directory, "paths.ts");
    const client = path.join(directory, "client.ts");
    writeFileSync(
      paths,
      'export const OCR_PATH = "/documents/ocr";\nexport const ocrFor = (id: string) => `/businesses/${id}/documents/ocr`;\nexport const EXTRACT = (id: string) => `/businesses/${id}/documents/extract`;'
    );
    writeFileSync(
      client,
      'import { OCR_PATH, ocrFor, EXTRACT as extractPath } from "./paths";\npostJson(OCR_PATH, {});\npostJson(ocrFor(id), {});\npostJson(extractPath(id), {});'
    );
    const calls = extractWebCalls([paths, client], routes).filter((call) =>
      call.file.endsWith("client.ts")
    );
    expect(calls.map((call) => [call.path, findRoute(routes, call).status])).toEqual([
      ["/documents/ocr", "missing"],
      [`/businesses/${D}/documents/ocr`, "missing"],
      [`/businesses/${D}/documents/extract`, "ok"]
    ]);
  });
});

describe("Edge-only routes and groups", () => {
  it("reads the methods the Edge-only routes accept from their code", () => {
    const source = ["application-routes.ts", "handler.ts", "public-routes.ts"]
      .map((file) => readFileSync(`supabase/functions/api/${file}`, "utf8"))
      .join("\n");
    const methods = (routePath: string) =>
      edgeOnlyRoutes(source)
        .filter((route) => route.path === routePath)
        .map((route) => route.method)
        .sort();
    expect(methods("/internal/jobs/:jobName/run")).toEqual(["POST"]);
    expect(methods("/internal/jobs/:jobName/status")).toEqual(["GET"]);
    expect(methods("/v1/realtime/events/:eventId/ack")).toEqual(["POST"]);
    expect(methods("/v1/shop-system/catalogue")).toEqual(["PUT"]);
    expect(methods("/public/storefronts")).toEqual(["GET"]);
    // The code answers /v1/realtime/connect for any method.
    expect(methods("/v1/realtime/connect")).toEqual(["*"]);
  });

  it("finds a business route group whatever the id parameter is called", () => {
    expect(businessRouteGroup("/businesses/:businessId/staff")).toBe("staff");
    expect(businessRouteGroup("/businesses/:shopId/new-thing/:x")).toBe("new-thing");
    expect(businessRouteGroup("/v1/conversations")).toBeUndefined();
  });
});

describe("round-4 review shapes", () => {
  // Each fixture function is one case; the verdict uses the same rule as the CI check.
  const verdict = (call: ReturnType<typeof extractWebCalls>[number]) =>
    call.problem ?? findRoute(routes, call).status;
  function project(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "project-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, routes).map((call) => ({
      file: path.basename(call.file),
      line: call.line,
      path: call.path.replaceAll(D, "${}"),
      verdict: verdict(call)
    }));
  }

  it("follows namespace, default, composed and nested imports to the module they name", () => {
    const calls = project({
      "paths.ts": [
        'export const DOCS = "/documents";',
        "export const OCR_COMPOSED = `${DOCS}/ocr`;",
        'export const ENDPOINT = "/auth/identity/merge/pin";',
        'export const api = { docs: { ocr: "/documents/ocr" } };',
        'export default "/documents/ocr";'
      ].join("\n"),
      "other.ts": 'export const ENDPOINT = "/documents/ocr";',
      "client.ts": [
        'import * as paths from "./paths";',
        'import DEFAULT_PATH, { OCR_COMPOSED, api, ENDPOINT } from "./paths";',
        "postJson(paths.OCR_COMPOSED, {});",
        "postJson(OCR_COMPOSED, {});",
        "postJson(api.docs.ocr, {});",
        "postJson(DEFAULT_PATH, {});",
        "postJson(ENDPOINT, {});"
      ].join("\n")
    }).filter((call) => call.file === "client.ts");
    expect(calls.map((call) => [call.line, call.verdict])).toEqual([
      [3, "missing"],
      [4, "missing"],
      [5, "missing"],
      [6, "missing"],
      // ENDPOINT comes from ./paths, not the same-named export in other.ts.
      [7, "ok"]
    ]);
  });

  it("checks wrappers, every return of a builder, and parameter defaults", () => {
    const calls = project({
      "client.ts": [
        'async function send(path: string) { return apiFetch(path, { method: "POST" }); }',
        'send("/documents/ocr");',
        'function ocrPath(id?: string) { if (id) return `/documents/${id}/ocr`; return "/documents/extract"; }',
        "postJson(ocrPath(), {});",
        'function h(p = "/documents/ocr") { return postJson(p, {}); }'
      ].join("\n")
    });
    expect(calls.filter((call) => call.verdict !== "ok").map((call) => call.line)).toEqual([
      2, 4, 4, 5
    ]);
  });

  it("reports a name it cannot resolve instead of skipping it", () => {
    const calls = project({
      "client.ts": "const api = { docs: {} };\npostJson(api.docs.ocr, {});"
    });
    expect(calls).toEqual([
      { file: "client.ts", line: 2, path: "api.docs.ocr", verdict: "unresolved" }
    ]);
  });

  it("treats raw fetch as web-origin relative and new URL with a leading slash as dropping /api", () => {
    const calls = project({
      "client.ts": [
        'fetch("/api/auth/identity/merge/pin", { method: "POST" });',
        'fetch("/auth/identity/merge/pin", { method: "POST" });',
        'fetch(new URL("/auth/identity/merge/pin", readApiBaseUrl()));',
        'const base = readApiBaseUrl(); fetch(base + "/documents/ocr", { method: "POST" });'
      ].join("\n")
    });
    expect(calls.map((call) => [call.line, call.verdict])).toEqual([
      [1, "ok"],
      [2, "bypasses_api_base"],
      [3, "url_drops_api_base"],
      [4, "missing"]
    ]);
  });

  it("does not flag third-party origins, same-origin assets, navigation or comparisons", () => {
    const calls = project({
      "client.ts": [
        "fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/token`);",
        'const tileHost = "https://tiles.example.com"; fetch(`${tileHost}/auth/${z}`);',
        'navigator.sendBeacon("/vitals", "x");',
        'history.pushState({}, "", `/businesses/${id}/orders`);',
        'window.location.assign("/auth/welcome");',
        'switch (p) { case "/documents/ocr": break; }',
        'const ok = pathname === "/auth/whatever";'
      ].join("\n"),
      "Help.tsx": 'export const Help = () => <a href="/auth/help">Help</a>;'
    });
    expect(calls.filter((call) => call.verdict !== "ok")).toEqual([]);
  });

  it("counts only the Edge routes production dispatches, and health as GET only", () => {
    const read = (file: string) => readFileSync(`supabase/functions/api/${file}`, "utf8");
    const reachable = reachableEdgeRoutes({
      application: read("application-routes.ts"),
      handler: read("handler.ts"),
      publicRoutes: read("public-routes.ts")
    });
    const pathsOf = new Set(reachable.map((route) => route.path));
    // application-routes declares conversation routes, but index.ts never sends them there.
    expect(pathsOf.has("/v1/conversations/:conversationId/messages")).toBe(false);
    expect(pathsOf.has("/internal/jobs/:jobName/run")).toBe(true);
    expect(
      reachable.filter((route) => route.path === "/health").map((route) => route.method)
    ).toEqual(["GET"]);
  });

  it("scans any Kotlin file that builds a URL on GROGONI_API_ORIGIN", () => {
    const file = path.join(directory, "Refresh.kt");
    writeFileSync(
      file,
      'val url = URL("${BuildConfig.GROGONI_API_ORIGIN}/businesses/$id/documents/ocr")\nval other = "/not/an/api/call"'
    );
    const calls = extractAndroidCalls([file]);
    expect(calls.map((call) => call.path)).toEqual([`/businesses/${D}/documents/ocr`]);
    expect(findRoute(routes, calls[0]!).status).toBe("missing");
  });
});

describe("round-5 review shapes", () => {
  const verdict = (call: ReturnType<typeof extractWebCalls>[number]) =>
    call.problem ?? findRoute(routes, call).status;
  function project(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "round5-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, routes).map((call) => ({
      line: call.line,
      path: call.path.replaceAll(D, "${}"),
      verdict: verdict(call)
    }));
  }
  const failing = (files: Record<string, string>) =>
    project(files)
      .filter((call) => call.verdict !== "ok")
      .map((call) => call.line);

  it("checks injected fetchers on a base built with ?? and .replace()", () => {
    expect(
      failing({
        "sync.ts": [
          "const fetcher = options.fetcher ?? globalThis.fetch;",
          'const apiBaseUrl = (options.apiBaseUrl ?? readApiBaseUrl()).replace(/\\/+$/u, "");',
          'fetcher(`${apiBaseUrl}/businesses/${id}/documents/ocrz`, { method: "POST" });',
          "async function read(doFetch: typeof fetch, base: string) { return doFetch(`${base}/documents/ocr`); }"
        ].join("\n")
      })
      // Line 4's base is a parameter: any origin, so only its call sites (with the API base) count.
    ).toEqual([3]);
  });

  it("follows workspace-package imports and literal element access, and reports what is missing", () => {
    const calls = project({
      "client.ts": [
        'import { NOT_A_REAL_EXPORT } from "@grogoni/shared-types";',
        'const PATHS = { ocr: "/documents/ocr" } as const;',
        "postJson(NOT_A_REAL_EXPORT, {});",
        'postJson(PATHS["ocr"], {});',
        "postJson(PATHS[key], {});"
      ].join("\n")
    });
    expect(calls.map((call) => [call.line, call.verdict])).toEqual([
      [3, "unresolved"],
      [4, "missing"]
    ]);
  });

  it("checks XHR, Request objects, API links and pass-through wrappers", () => {
    expect(
      failing({
        "client.tsx": [
          'xhr.open("POST", `${readApiBaseUrl()}/businesses/${id}/documents/ocr`);',
          'fetch(new Request(`${readApiBaseUrl()}/documents/ocr`, { method: "POST" }));',
          "window.open(`${readApiBaseUrl()}/businesses/${id}/exportz`);",
          "export const Link = () => <a href={`${readApiBaseUrl()}/businesses/${id}/exports/orderz.csv`}>x</a>;",
          "postJson(String(`/businesses/${id}/documents/ocr`), {});",
          'apiFetch(encodeURI(`/documents/ocr/${id}`), { method: "POST" });'
        ].join("\n")
      })
    ).toEqual([1, 2, 2, 3, 4, 5, 6]);
  });

  it("checks wrappers that append a query or take the method as a parameter", () => {
    expect(
      failing({
        "client.ts": [
          'async function send(path: string, query = "") { return apiFetch(`${path}${query}`, { method: "POST" }); }',
          'send("/documents/ocr");',
          "function call(method: string, path: string) { return apiFetch(path, { method }); }",
          'call("DELETE", "/auth/identity/merge/pin");',
          'call("POST", "/auth/identity/merge/pin");'
        ].join("\n")
      })
    ).toEqual([2, 4]);
  });

  it("checks object and class method wrappers by method, not by a same-named function", () => {
    expect(
      failing({
        "client.ts": [
          "const api = { post: (p: string, body: unknown) => postJson(p, body) };",
          'api.post("/documents/ocr", {});',
          'class Client { send(p: string) { return apiFetch(p, { method: "POST" }); } ocr() { return this.send("/documents/ocr"); } }',
          'xhr.send("/not/a/path");'
        ].join("\n")
      })
    ).toEqual([2, 3]);
  });

  it("accepts query helpers, spliced sub-paths and SPA route tables", () => {
    expect(
      failing({
        "client.ts": [
          'export const screens = { security: "/auth/security", board: "/businesses/orders-board" };',
          'fetch(`/api/auth/identity/merge/pin?${params}`, { method: "POST" });',
          'postJson("/businesses/" + id + "/documents/extract" + q, {});',
          "postJson(`/businesses/${id}/documents/extract${queryString}`, {});",
          "function biz(id: string, tail: string) { return postJson(`/businesses/${id}${tail}`, {}); }",
          'async function load(path: string, search: string) { return apiFetch(`${path}?${search}`, { method: "POST" }); }'
        ].join("\n")
      })
    ).toEqual([]);
  });

  it("reads Android origins held in a variable", () => {
    const file = path.join(directory, "OriginVariable.kt");
    writeFileSync(
      file,
      [
        "val base = BuildConfig.GROGONI_API_ORIGIN",
        'val a = URL("$base/businesses/$id/documents/ocr")',
        'val b = URL(base + "/businesses/" + id + "/documents/ocr")'
      ].join("\n")
    );
    expect(
      extractAndroidCalls([file]).map((call) => [call.line, call.path, call.suffixOnly])
    ).toEqual([
      [2, `/businesses/${D}/documents/ocr`, false],
      [3, `/businesses/${D}/documents/ocr`, false]
    ]);
  });
});

describe("round-6 review shapes", () => {
  const verdict = (call: ReturnType<typeof extractWebCalls>[number]) =>
    call.problem ?? findRoute(routes, call).status;
  function failing(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "round6-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, routes)
      .filter((call) => verdict(call) !== "ok")
      .map((call) => `${path.basename(call.file)}:${call.line}`);
  }

  it("checks a request function injected as a parameter default (pos-sale.ts)", () => {
    expect(
      failing({
        "pos.ts": [
          "export async function sell(id: string, request: PosJsonRequest = postJson) {",
          "  await request(`/businesses/${id}/documents/extract`, {});",
          "  await request(`/businesses/${id}/documents/extractz`, {});",
          "}"
        ].join("\n")
      })
    ).toEqual(["pos.ts:3"]);
  });

  it("checks unmistakable API paths held as data (prefetch lists, WebSocket URLs, links)", () => {
    expect(
      failing({
        "prefetch.ts": [
          "export const lightweight = (id: string) => [`/businesses/${id}/documents/extract`, `/businesses/${id}/reportz`, `/v1/conversationz`];",
          "export const socket = () => new WebSocket(`${readApiBaseUrl()}/v1/realtimez`);",
          'export const screens = { security: "/auth/security", board: "/businesses/orders-board" };',
          "a.href = `${readApiBaseUrl()}/businesses/${id}/exportz`;"
        ].join("\n")
      })
    ).toEqual(["prefetch.ts:1", "prefetch.ts:1", "prefetch.ts:2", "prefetch.ts:4"]);
  });

  it("follows import aliases and does not take project helpers for fetch by their name", () => {
    expect(
      failing({
        "client.ts": [
          'import { postJson as post } from "./helpers";',
          'post("/documents/ocr", {});',
          "async function safeFetch(path: string) { try { return await apiFetch(path); } catch { return null; } }",
          'safeFetch("/v1/conversations");',
          'safeFetch("/documents/ocrz");'
        ].join("\n"),
        "helpers.ts":
          'export async function postJson(path: string, body: unknown) { return apiFetch(path, { method: "POST" }); }'
      })
    ).toEqual(["client.ts:2", "client.ts:5"]);
  });

  it("checks endpoint-table builders, XHR with a variable method, imported method wrappers and every cache key", () => {
    expect(
      failing({
        "client.ts": [
          'import { api } from "./api";',
          "const endpoints = { ocr: (id: string) => `/businesses/${id}/documents/ocr` };",
          "postJson(endpoints.ocr(id), {});",
          "xhr.open(method, `${readApiBaseUrl()}/businesses/${id}/documents/ocr`);",
          'api.post("/documents/ocr", {});',
          "useApiMutationRevision(`/businesses/${id}/products`, `/businesses/${id}/invoicez`);",
          'fetch(new URL("/api/documents/ocr", window.location.origin));'
        ].join("\n"),
        "api.ts": "export const api = { post: (p: string, body: unknown) => postJson(p, body) };"
      })
    ).toEqual([
      "client.ts:2",
      "client.ts:3",
      "client.ts:4",
      "client.ts:5",
      // Both cache keys: this test's route table has no /products route either.
      "client.ts:6",
      "client.ts:6",
      "client.ts:7"
    ]);
  });

  it("checks a wrapper's call sites as well as its own parameter-based request", () => {
    expect(
      failing({
        "client.ts": [
          "function items(base: string) { return apiFetch(`${base}/items`); }",
          "items(`/businesses/${id}/product-captures/${job}`);"
        ].join("\n")
      })
      // The tail inside the wrapper fails only when every call site fails too.
    ).toEqual(["client.ts:1", "client.ts:2"]);
  });
});

describe("round-7 review shapes", () => {
  const verdict = (call: ReturnType<typeof extractWebCalls>[number]) =>
    call.problem ?? findRoute(routes, call).status;
  function failing(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "round7-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, routes)
      .filter((call) => verdict(call) !== "ok")
      .map((call) => `${path.basename(call.file)}:${call.line}:${call.path.replaceAll(D, "${}")}`);
  }

  it("binds builder arguments, including this.path(...) (runtime-handoff-controller.ts)", () => {
    expect(
      failing({
        "controller.ts": [
          "class Controller {",
          '  private path(id: string, suffix = "") { return `/businesses/${encodeURIComponent(id)}${suffix}`; }',
          '  ok(id: string) { return this.deps.cloud(this.path(id, "/documents/extract"), {}); }',
          '  bad(id: string) { return this.deps.cloud(this.path(id, "/documents/extractz"), {}); }',
          "}",
          'function runtimePath(id: string, suffix = "") { return `/businesses/${id}${suffix}`; }',
          'postJson(runtimePath(id, "/documents/ocr"), {});'
        ].join("\n")
      })
    ).toEqual([
      "controller.ts:4:/businesses/${}/documents/extractz",
      "controller.ts:7:/businesses/${}/documents/ocr"
    ]);
  });

  it("reads methods in scope, through `as const` and method tables", () => {
    expect(
      failing({
        "client.ts": [
          'function a() { const init = { method: "DELETE" }; return init; }',
          'function list(init = {}) { return apiFetch("/v1/conversations", init); }',
          'const METHOD = { remove: "DELETE" } as const;',
          'apiFetch("/v1/conversations", { method: METHOD.remove });',
          'apiFetch("/v1/conversations", { method: "DELETE" as const });'
        ].join("\n")
      })
    ).toEqual(["client.ts:4:/v1/conversations", "client.ts:5:/v1/conversations"]);
  });

  it("treats the Vite API base as the API, and other bases it cannot see as other origins", () => {
    expect(
      failing({
        "client.ts": [
          "fetch(`${import.meta.env.VITE_API_BASE_URL}/v1/conversationz`);",
          'function chat(endpoint: string) { return fetch(`${endpoint}/v1/chat/completions`, { method: "POST" }); }',
          "function run(runtime: { endpoint: string }) { return fetch(`${runtime.endpoint}/v1/chat/completions`); }"
        ].join("\n")
      })
    ).toEqual(["client.ts:1:/v1/conversationz"]);
  });

  it("finds default-exported and re-exported-under-another-name wrappers, and hook callbacks", () => {
    expect(
      failing({
        "loader.ts": [
          "export default function load(path: string) { return getJson(path); }",
          "export function loadNamed(path: string) { return getJson(path); }"
        ].join("\n"),
        "barrel.ts": 'export { loadNamed as loadAuth } from "./loader";',
        "client.ts": [
          'import load from "./loader";',
          'import { loadAuth } from "./barrel";',
          'load("/auth/acountz");',
          'loadAuth("/auth/acountz");',
          "const load2 = useCallback((path: string) => getJson(path), []);",
          'load2("/auth/acountz");',
          'function call(path: string) { return apiFetch(path.startsWith("/") ? path : `/${path}`); }',
          'call("/auth/acountz");'
        ].join("\n")
      }).filter((entry) => entry.startsWith("client.ts"))
    ).toEqual([
      "client.ts:3:/auth/acountz",
      "client.ts:4:/auth/acountz",
      "client.ts:6:/auth/acountz",
      "client.ts:8:/auth/acountz"
    ]);
  });

  it('checks URLs derived with .replace(/...$/, "/v1/...") as suffixes, and the base as a prefix', () => {
    const shopRoutes = [
      ...routes,
      { method: "PUT", path: "/v1/shop-system/catalogue" },
      { method: "GET", path: "/v1/shop-system/orders" }
    ];
    const folder = mkdtempSync(path.join(directory, "round7-shop-"));
    const file = path.join(folder, "panel.ts");
    writeFileSync(
      file,
      [
        'const apiBaseUrl = shopConnectionUrl.replace(/\\/mcp\\?shopId=.*$/u, "/v1/shop-system");',
        "export const config = { catalogue: `${apiBaseUrl}/catalogue`, orders: `${apiBaseUrl}/orderz` };"
      ].join("\n")
    );
    const calls = extractWebCalls([file], shopRoutes).map((call) => [
      call.line,
      call.path,
      findRoute(shopRoutes, call).status
    ]);
    expect(calls).toEqual([
      [1, "/v1/shop-system", "ok"],
      [2, "/v1/shop-system/catalogue", "ok"],
      [2, "/v1/shop-system/orderz", "missing"]
    ]);
  });

  it("reads Kotlin concatenation split across lines, keeping the first line's number", () => {
    const file = path.join(directory, "MultiLine.kt");
    writeFileSync(
      file,
      [
        "private fun request(method: String, path: String) = Unit",
        "fun ack(id: String) = request(",
        '    "POST",',
        '    "/v1/devices/native-sms/commands/" +',
        '        id + "/acknowledge"',
        ")"
      ].join("\n")
    );
    expect(extractAndroidCalls([file]).map((call) => [call.line, call.method, call.path])).toEqual([
      [4, "POST", `/v1/devices/native-sms/commands/${D}/acknowledge`]
    ]);
  });
});

describe("round-8 review shapes", () => {
  it("checks wrappers that take the API base as a parameter, or as input.base, at their call sites", () => {
    const deviceRoutes = [
      ...routes,
      { method: "GET", path: "/v1/ai/turn-stream/:turnId" },
      { method: "GET", path: "/v1/ai/device-inference/jobs/next" },
      { method: "POST", path: "/v1/ai/device-inference/jobs/:id/result" }
    ];
    const folder = mkdtempSync(path.join(directory, "round8-"));
    const file = path.join(folder, "companion.ts");
    // The shapes of apps/web/src/inference/agent-turn-companion.ts, with one tail broken each.
    writeFileSync(
      file,
      [
        "export function start(options: { fetchImpl?: typeof fetch; baseUrl?: string }) {",
        "  const doFetch = options.fetchImpl ?? fetch;",
        "  const base = options.baseUrl ?? readApiBaseUrl();",
        '  void readTurnStream(doFetch, base, "turn");',
        "  void serveJobs({ doFetch, base });",
        "}",
        "async function readTurnStream(doFetch: typeof fetch, base: string, turnId: string) {",
        "  return doFetch(`${base}/v1/ai/turn-streamz/${encodeURIComponent(turnId)}`);",
        "}",
        "async function serveJobs(input: { doFetch: typeof fetch; base: string }) {",
        "  await input.doFetch(`${input.base}/v1/ai/device-inference/jobs/next?${query.toString()}`);",
        "  const post = (path: string) =>",
        '    input.doFetch(`${input.base}/v1/ai/device-inference/jobz/${id}/${path}`, { method: "POST" });',
        "}"
      ].join("\n")
    );
    const calls = extractWebCalls([file], deviceRoutes).map((call) => [
      call.line,
      call.method,
      call.path.replaceAll(D, "${}"),
      findRoute(deviceRoutes, call).status
    ]);
    expect(calls).toEqual([
      [4, "GET", "/v1/ai/turn-streamz/${}", "missing"],
      [5, "GET", "/v1/ai/device-inference/jobs/next", "ok"],
      [5, "POST", "/v1/ai/device-inference/jobz/${}/${}", "missing"]
    ]);
  });
});

describe("round-9 review shapes", () => {
  const importRoutes = [
    ...routes,
    { method: "POST", path: "/businesses/:businessId/imports/supplier-csv" },
    { method: "POST", path: "/businesses/:businessId/imports/product-catalogue" },
    { method: "POST", path: "/businesses/:businessId/contacts/import" },
    { method: "POST", path: "/businesses/:businessId/contacts/sync" }
  ];
  function check(source: string, routeTable = importRoutes) {
    const folder = mkdtempSync(path.join(directory, "round9-"));
    const file = path.join(folder, "client.ts");
    writeFileSync(file, source);
    return extractWebCalls([file], routeTable).map((call) => [
      call.line,
      call.path.replaceAll(D, "${}"),
      call.problem ?? findRoute(routeTable, call).status
    ]);
  }

  it("expands later path words from constant ternaries and string-literal unions (useImportsState, CanonicalContactsCard)", () => {
    const source = [
      'type ContactAction = "import" | "sync";',
      'function run(id: string, kind: "supplier" | "catalogue", action: ContactAction) {',
      '  const endpoint = kind === "supplier" ? "supplier-csv" : "product-catalogue";',
      "  postJson(`/businesses/${id}/imports/${endpoint}`, {});",
      "  postJson(`/businesses/${id}/contacts/${action}`, {});",
      "}"
    ].join("\n");
    expect(check(source)).toEqual([
      [4, "/businesses/${}/imports/supplier-csv", "ok"],
      [4, "/businesses/${}/imports/product-catalogue", "ok"],
      [5, "/businesses/${}/contacts/import", "ok"],
      [5, "/businesses/${}/contacts/sync", "ok"]
    ]);
    // Removing a route on the server makes the client call that needs it fail.
    const withoutSync = importRoutes.filter((route) => !route.path.endsWith("/contacts/sync"));
    expect(check(source, withoutSync).filter((call) => call[2] !== "ok")).toEqual([
      [5, "/businesses/${}/contacts/sync", "missing"]
    ]);
  });

  it("follows a wrapper's parameter in any position, through local constants and EventSource", () => {
    const source = [
      "function a(p: string) { return fetch(`${readApiBaseUrl()}${p}`); }",
      'a("/auth/acountz");',
      "function b(p: string) { const url = `${readApiBaseUrl()}/v1${p}`; return fetch(url); }",
      'b("/conversationz");',
      "function c(id: string, tail: string) { return postJson(`/businesses/${id}${tail}`, {}); }",
      'c(id, "/imports/supplier-csv");',
      'c(id, "/imports/supplier-csvz");',
      "function d(base: string, p: string) { return fetch(`${base}${p}`); }",
      'd(readApiBaseUrl(), "/auth/acountz");',
      "function e(p: string) { return new EventSource(`${readApiBaseUrl()}${p}`); }",
      'e("/v1/realtimez");'
    ].join("\n");
    expect(check(source).filter((call) => call[2] !== "ok")).toEqual([
      [2, "/auth/acountz", "missing"],
      [4, "/v1/conversationz", "missing"],
      [7, "/businesses/${}/imports/supplier-csvz", "missing"],
      [9, "/auth/acountz", "missing"],
      [11, "/v1/realtimez", "missing"]
    ]);
  });

  it("resolves a property of an object a builder returns", () => {
    const source = [
      "const NET = { connection: (id: string) => ({ respond: `/businesses/${id}/contacts/sync` }) };",
      "postJson(NET.connection(id).respond, {});"
    ].join("\n");
    // Line 1 is the builder's own template, checked where it is declared.
    expect(check(source)).toEqual([
      [1, "/businesses/${}/contacts/sync", "ok"],
      [2, "/businesses/${}/contacts/sync", "ok"]
    ]);
  });
});

describe("round-10 review shapes", () => {
  it("resolves concatenation of two names, including in wrappers", () => {
    const folder = mkdtempSync(path.join(directory, "round10-"));
    const file = path.join(folder, "client.ts");
    writeFileSync(
      file,
      [
        'const ROOT = "/auth"; const SUB = "/acountz"; const OK = "/identity/merge/pin";',
        "getJson(ROOT + SUB);",
        "postJson(ROOT + OK, {});",
        "function g(p: string) { return fetch(readApiBaseUrl() + p); }",
        'g("/auth/acountz");'
      ].join("\n")
    );
    const calls = extractWebCalls([file], routes)
      .filter((call) => (call.problem ?? findRoute(routes, call).status) !== "ok")
      .map((call) => [call.line, call.path]);
    expect(calls).toEqual([
      [2, "/auth/acountz"],
      [5, "/auth/acountz"]
    ]);
  });

  it("checks a wrapper declared inside a wrapper, with both calls bound (agent-turn-companion post)", () => {
    const deviceRoutes = [
      ...routes,
      { method: "POST", path: "/v1/ai/device-inference/jobs/:id/result" },
      { method: "POST", path: "/v1/ai/device-inference/jobs/:id/failure" }
    ];
    const folder = mkdtempSync(path.join(directory, "round10-nested-"));
    const file = path.join(folder, "companion.ts");
    writeFileSync(
      file,
      [
        "export function start() { void serveJobs({ doFetch: fetch, base: readApiBaseUrl() }); }",
        "async function serveJobs(input: { doFetch: typeof fetch; base: string }) {",
        "  const post = (path: string) =>",
        '    input.doFetch(`${input.base}/v1/ai/device-inference/jobs/${id}/${path}`, { method: "POST" });',
        '  await post("result");',
        '  await post("failed");',
        "}"
      ].join("\n")
    );
    const results = extractWebCalls([file], deviceRoutes)
      .filter((call) => call.line === 1)
      .map((call) => [call.path.replaceAll(D, "${}"), findRoute(deviceRoutes, call).status]);
    expect(results).toEqual(
      expect.arrayContaining([
        ["/v1/ai/device-inference/jobs/${}/result", "ok"],
        ["/v1/ai/device-inference/jobs/${}/failed", "missing"]
      ])
    );
  });
});

describe("round-11 review shapes", () => {
  const deviceRoutes = [
    ...routes,
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/result" },
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/failure" }
  ];
  const failing = (file: string) =>
    extractWebCalls([file], deviceRoutes)
      .filter((call) => (call.problem ?? findRoute(deviceRoutes, call).status) !== "ok")
      .map((call) => [call.line, call.path.replaceAll(D, "${}")]);

  it("resolves a called name by scope, so a later same-named function does not hide a nested wrapper", () => {
    const folder = mkdtempSync(path.join(directory, "round11-"));
    const file = path.join(folder, "companion.ts");
    writeFileSync(
      file,
      [
        "export function start() { void serveJobs({ doFetch: fetch, base: readApiBaseUrl() }); }",
        "async function serveJobs(input: { doFetch: typeof fetch; base: string }) {",
        "  const post = (path: string) =>",
        '    input.doFetch(`${input.base}/v1/ai/device-inference/jobs/${id}/${path}`, { method: "POST" });',
        '  await post("results");',
        '  await post("failure");',
        "}",
        "export function retryLabel(n: number): string {",
        "  const post = (suffix: string) => `attempt ${n} ${suffix}`;",
        '  return post("pending");',
        "}"
      ].join("\n")
    );
    expect(failing(file)).toEqual([[1, "/v1/ai/device-inference/jobs/${}/results"]]);
  });

  it("checks each of two same-named nested wrappers in either order", () => {
    const folder = mkdtempSync(path.join(directory, "round11-twins-"));
    const file = path.join(folder, "twins.ts");
    writeFileSync(
      file,
      [
        "async function serveA(input: { doFetch: typeof fetch; base: string }) {",
        "  const post = (path: string) =>",
        '    input.doFetch(`${input.base}/v1/ai/device-inference/jobs/x/${path}`, { method: "POST" });',
        '  await post("resultz");',
        "}",
        "async function serveB(input: { doFetch: typeof fetch; base: string }) {",
        "  const post = (path: string) =>",
        '    input.doFetch(`${input.base}/v1/ai/device-inference/jobs/y/${path}`, { method: "POST" });',
        '  await post("failurez");',
        "}",
        "export const e = () => {",
        "  void serveA({ doFetch: fetch, base: readApiBaseUrl() });",
        "  void serveB({ doFetch: fetch, base: readApiBaseUrl() });",
        "};"
      ].join("\n")
    );
    expect(failing(file)).toEqual([
      [12, "/v1/ai/device-inference/jobs/x/resultz"],
      [13, "/v1/ai/device-inference/jobs/y/failurez"]
    ]);
  });

  it("binds a wrapper or builder call to the declaration in scope, not a same-named one elsewhere", () => {
    const folder = mkdtempSync(path.join(directory, "round11-scope-"));
    const file = path.join(folder, "scope.ts");
    writeFileSync(
      file,
      [
        "function a() {",
        "  const load = (p: string) => getJson(`/businesses/${id}${p}`);",
        '  void load("/supplierz");',
        "}",
        "function b() {",
        "  const load = (p: string) => `label ${p}`;",
        '  void load("/anything");',
        "}",
        "function c() {",
        "  const url = (p: string) => `/auth${p}`;",
        '  void getJson(url("/acountz"));',
        "}",
        "function d() {",
        "  const url = (p: string) => `/elsewhere${p}`;",
        '  void url("/x");',
        "}"
      ].join("\n")
    );
    expect(failing(file)).toEqual([
      [3, "/businesses/${}/supplierz"],
      [11, "/auth/acountz"]
    ]);
  });
});

describe("round-12 review shapes", () => {
  const deviceRoutes = [
    ...routes,
    { method: "GET", path: "/v1/ai/device-inference/jobs/:id/result" },
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/result" },
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/failure" }
  ];
  function failing(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "round12-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, deviceRoutes)
      .filter((call) => (call.problem ?? findRoute(deviceRoutes, call).status) !== "ok")
      .map((call) => [path.basename(call.file), call.line, call.path.replaceAll(D, "${}")]);
  }
  const wrap = [
    "export function sendJob(id: string, step: string) {",
    "  return postJson(`/v1/ai/device-inference/jobs/${id}/${step}`, {});",
    "}",
    "export const jobPath = (id: string, step: string) => `/v1/ai/device-inference/jobs/${id}/${step}`;"
  ].join("\n");

  it("follows an imported wrapper or builder even when a function elsewhere in the file has its name", () => {
    expect(
      failing({
        "wrap.ts": wrap,
        "client.ts": [
          'import { sendJob, jobPath } from "./wrap";',
          'export const go = () => sendJob("j", "resultz");',
          'export const go2 = () => postJson(jobPath("j", "failurez"), {});',
          'export const ok = () => sendJob("j", "result");',
          "export function other(base: string) {",
          "  const sendJob = (n: string) => fetch(`${base}/telemetry/${n}`);",
          "  const jobPath = (label: string) => label.trim();",
          '  return [sendJob("2"), jobPath(" x ")];',
          "}"
        ].join("\n")
      })
    ).toEqual([
      ["client.ts", 2, "/v1/ai/device-inference/jobs/j/resultz"],
      ["client.ts", 3, "/v1/ai/device-inference/jobs/j/failurez"]
    ]);
  });

  it("lets destructured parameters and loop variables hide a same-named wrapper", () => {
    expect(
      failing({
        "client.ts": [
          "const post = (path: string) => postJson(`/v1/ai/device-inference/jobs/x/${path}`, {});",
          'export const real = () => post("failurez");',
          "export async function run({ post }: { post: (p: string) => Promise<unknown> }) {",
          '  await post("anything-goes");',
          "}",
          "export function each(handlers: Array<(s: string) => void>) {",
          '  for (const post of handlers) post("hello-world");',
          "  try { void 0; } catch (post) { void post; }",
          "}"
        ].join("\n")
      })
    ).toEqual([["client.ts", 2, "/v1/ai/device-inference/jobs/x/failurez"]]);
  });

  it("binds this.method to the class it is called in, inherited methods included", () => {
    expect(
      failing({
        "client.ts": [
          "export class A {",
          "  private send(step: string) { return postJson(`/v1/ai/device-inference/jobs/x/${step}`, {}); }",
          "  private path(id: string, s: string) { return `/v1/ai/device-inference/jobs/${id}${s}`; }",
          '  run() { return [this.send("resultw"), getJson(this.path("x", "/resultm"))]; }',
          "}",
          "export class B {",
          "  send(message: string) { console.log(message); }",
          "  private path(s: string) { return s.trim(); }",
          '  go() { return this.path(" y "); }',
          "}",
          'export class C extends A { again() { return this.send("failurev"); } }',
          "export const handlers = { send: (message: string) => console.log(message) };"
        ].join("\n")
      })
    ).toEqual([
      ["client.ts", 4, "/v1/ai/device-inference/jobs/x/resultw"],
      ["client.ts", 4, "/v1/ai/device-inference/jobs/x/resultm"],
      ["client.ts", 11, "/v1/ai/device-inference/jobs/x/failurev"]
    ]);
  });

  it("reads a constant or receiver from the declaration in scope, not a same-named local elsewhere", () => {
    expect(
      failing({
        "client.ts": [
          "export function a() {",
          '  const PATH = "/v1/ai/device-inference/jobs/x/result";',
          "  const api = { post: (message: string) => console.log(message) };",
          '  return [getJson(PATH), api.post("x")];',
          "}",
          'const PATH = "/v1/ai/device-inference/jobs/x/resultk";',
          "const api = { post: (step: string) => postJson(`/v1/ai/device-inference/jobs/x/${step}`, {}) };",
          "export function b() {",
          '  return [getJson(PATH), api.post("failurek")];',
          "}",
          "export function c({ PATH }: { PATH: string }) {",
          "  return getJson(PATH);",
          "}"
        ].join("\n")
      })
    ).toEqual([
      // The constant itself is an unmistakable API path held as data.
      ["client.ts", 6, "/v1/ai/device-inference/jobs/x/resultk"],
      ["client.ts", 9, "/v1/ai/device-inference/jobs/x/resultk"],
      ["client.ts", 9, "/v1/ai/device-inference/jobs/x/failurek"]
    ]);
  });

  it("checks a fetch parameter whatever a sibling function declares under its name", () => {
    expect(
      failing({
        "client.ts": [
          "export async function a(doFetch: typeof fetch = fetch) {",
          '  return doFetch("/api/v1/ai/device-inference/jobs/x/resultf", { method: "POST" });',
          "}",
          "export function b() { const doFetch = () => Promise.resolve(1); return doFetch(); }"
        ].join("\n")
      })
    ).toEqual([["client.ts", 2, "/v1/ai/device-inference/jobs/x/resultf"]]);
  });
});

describe("round-13 review shapes", () => {
  const deviceRoutes = [
    ...routes,
    { method: "GET", path: "/v1/ai/device-inference/jobs/:id/result" },
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/result" },
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/failure" }
  ];
  function failing(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "round13-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, deviceRoutes)
      .filter((call) => (call.problem ?? findRoute(deviceRoutes, call).status) !== "ok")
      .map((call) => [path.basename(call.file), call.line, call.path.replaceAll(D, "${}")]);
  }
  const wrap = [
    "function sendJob(id: string, step: string) {",
    "  return postJson(`/v1/ai/device-inference/jobs/${id}/${step}`, {});",
    "}",
    "const jobPath = (id: string, step: string) => `/v1/ai/device-inference/jobs/${id}/${step}`;",
    'const JOBS_BASE = "/v1/ai/device-inference/jobs";',
    "export { sendJob, jobPath, JOBS_BASE };",
    "export { sendJob as fireJob };",
    "export function directJob(id: string, step: string) {",
    "  return postJson(`/v1/ai/device-inference/jobs/${id}/${step}`, {});",
    "}",
    "export const directPath = (id: string, step: string) => `/v1/ai/device-inference/jobs/${id}/${step}`;",
    "export class JobClient {",
    "  send(step: string) { return postJson(`/v1/ai/device-inference/jobs/x/${step}`, {}); }",
    "}",
    "export const jobApi = {",
    "  send: (step: string) => postJson(`/v1/ai/device-inference/jobs/x/${step}`, {})",
    "};"
  ].join("\n");

  it("follows local export lists (`export { x }`, `export { x as y }`) for wrappers, builders and constants", () => {
    expect(
      failing({
        "wrap.ts": wrap,
        "client.ts": [
          'import { sendJob, jobPath, fireJob, JOBS_BASE } from "./wrap";',
          'export const a = () => sendJob("j", "resultq1");',
          'export const b = () => getJson(jobPath("j", "resultq2"));',
          'export const c = () => fireJob("j", "resultq2b");',
          "export const d = () => postJson(`${JOBS_BASE}/x/result`, {});",
          'export const e = () => sendJob("j", "result");'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([
      ["client.ts", 2, "/v1/ai/device-inference/jobs/j/resultq1"],
      ["client.ts", 3, "/v1/ai/device-inference/jobs/j/resultq2"],
      ["client.ts", 4, "/v1/ai/device-inference/jobs/j/resultq2b"]
    ]);
  });

  it("resolves namespace-imported wrappers and builders, and methods of imported classes and objects", () => {
    expect(
      failing({
        "wrap.ts": wrap,
        "client.ts": [
          'import * as W from "./wrap";',
          'import { JobClient, jobApi } from "./wrap";',
          'export const a = () => W.directJob("j", "resultq3");',
          'export const b = () => getJson(W.directPath("j", "resultq3b"));',
          "const client = new JobClient();",
          'export const c = () => client.send("resultq23");',
          'export const d = () => jobApi.send("resultq23b");',
          'export const e = () => new JobClient().send("resultq23c");'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([
      ["client.ts", 3, "/v1/ai/device-inference/jobs/j/resultq3"],
      ["client.ts", 4, "/v1/ai/device-inference/jobs/j/resultq3b"],
      ["client.ts", 6, "/v1/ai/device-inference/jobs/x/resultq23"],
      ["client.ts", 7, "/v1/ai/device-inference/jobs/x/resultq23b"],
      ["client.ts", 8, "/v1/ai/device-inference/jobs/x/resultq23c"]
    ]);
  });

  it("resolves `new C().m()`, static methods and `satisfies` receivers, and reads a class-field base as a prefix", () => {
    expect(
      failing({
        "client.ts": [
          "class C {",
          '  private readonly base = "/v1/ai/device-inference/jobs";',
          "  send(step: string) { return postJson(`/v1/ai/device-inference/jobs/x/${step}`, {}); }",
          "  static send(step: string) { return postJson(`/v1/ai/device-inference/jobs/y/${step}`, {}); }",
          "}",
          'export const a = () => new C().send("resultq22");',
          'export const b = () => C.send("resultq28");',
          "interface Api { send(step: string): Promise<unknown> }",
          "const api = {",
          "  send: (s: string) => postJson(`/v1/ai/device-inference/jobs/x/${s}`, {})",
          "} satisfies Api;",
          'export const c = () => api.send("resultq27");'
        ].join("\n")
      })
    ).toEqual([
      ["client.ts", 6, "/v1/ai/device-inference/jobs/x/resultq22"],
      ["client.ts", 7, "/v1/ai/device-inference/jobs/y/resultq28"],
      ["client.ts", 12, "/v1/ai/device-inference/jobs/x/resultq27"]
    ]);
  });

  it("never takes the importing module for the unique exporter of a name it re-exports", () => {
    expect(
      failing({
        "barrel.ts": [
          'import { pickDevice } from "@unresolvable/package";',
          "export { pickDevice };",
          'export const go = () => pickDevice("/v1/ai/device-inference/jobs/x/result");'
        ].join("\n")
      })
    ).toEqual([]);
  });
});

describe("round-14 review shapes", () => {
  const deviceRoutes = [
    ...routes,
    { method: "GET", path: "/v1/ai/device-inference/jobs/:id/result" },
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/result" }
  ];
  function failing(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "round14-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, deviceRoutes)
      .filter((call) => (call.problem ?? findRoute(deviceRoutes, call).status) !== "ok")
      .map((call) => [path.basename(call.file), call.line, call.path.replaceAll(D, "${}")]);
  }
  const jobs = [
    'export const OK = "/v1/ai/device-inference/jobs/x/result";',
    "export function directJob(id: string, step: string) {",
    "  return postJson(`/v1/ai/device-inference/jobs/${id}/${step}`, {});",
    "}",
    "export const directPath = (id: string, step: string) => `/v1/ai/device-inference/jobs/${id}/${step}`;",
    "export class JobClient {",
    "  send(step: string) { return postJson(`/v1/ai/device-inference/jobs/x/${step}`, {}); }",
    "  static fire(step: string) { return postJson(`/v1/ai/device-inference/jobs/y/${step}`, {}); }",
    "}",
    "export const Expr = class {",
    "  send(step: string) { return postJson(`/v1/ai/device-inference/jobs/z/${step}`, {}); }",
    "};",
    "export const jobApi = {",
    "  send: (step: string) => postJson(`/v1/ai/device-inference/jobs/w/${step}`, {})",
    "};"
  ].join("\n");

  it("follows `export * as ns from` through barrels, for constants, wrappers and builders", () => {
    expect(
      failing({
        "jobs.ts": jobs,
        "inner.ts": 'export * as ns from "./jobs";',
        "barrel.ts": 'export * from "./inner";',
        "client.ts": [
          'import { ns } from "./barrel";',
          "export const a = () => getJson(ns.OK);",
          'export const b = () => ns.directJob("j", "resultns");',
          'export const c = () => getJson(ns.directPath("j", "resultnp"));'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([
      ["client.ts", 3, "/v1/ai/device-inference/jobs/j/resultns"],
      ["client.ts", 4, "/v1/ai/device-inference/jobs/j/resultnp"]
    ]);
  });

  it("checks anonymous default-exported wrappers, also re-exported under a name", () => {
    expect(
      failing({
        "fn.ts": [
          "export default function (id: string, step: string) {",
          "  return postJson(`/v1/ai/device-inference/jobs/${id}/${step}`, {});",
          "}"
        ].join("\n"),
        "arrow.ts":
          "export default (id: string, step: string) => postJson(`/v1/ai/device-inference/jobs/${id}/${step}`, {});",
        "names.ts": 'export { default as ad } from "./arrow";',
        "client.ts": [
          'import d from "./fn";',
          'import { ad } from "./names";',
          'export const a = () => d("j", "resultd");',
          'export const b = () => ad("j", "resultad");',
          'export const c = () => d("j", "result");'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([
      ["client.ts", 3, "/v1/ai/device-inference/jobs/j/resultd"],
      ["client.ts", 4, "/v1/ai/device-inference/jobs/j/resultad"]
    ]);
  });

  it("never lets a project export stand in for an unresolvable package import", () => {
    expect(
      failing({
        "jobs.ts": jobs,
        "client.ts": [
          'import { directJob } from "some-external-sdk";',
          'export const a = () => directJob("j", "notOurs");'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([]);
  });

  it("resolves imported class expressions, and classes and objects reached through a namespace", () => {
    expect(
      failing({
        "jobs.ts": jobs,
        "client.ts": [
          'import * as W from "./jobs";',
          'import { Expr } from "./jobs";',
          'export const a = () => new Expr().send("resulte");',
          "const e = new Expr();",
          'export const b = () => e.send("resulte2");',
          'export const c = () => new W.JobClient().send("resultw");',
          'export const d = () => W.JobClient.fire("resultf");',
          'export const f = () => W.jobApi.send("resulta");'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([
      ["client.ts", 3, "/v1/ai/device-inference/jobs/z/resulte"],
      ["client.ts", 5, "/v1/ai/device-inference/jobs/z/resulte2"],
      ["client.ts", 6, "/v1/ai/device-inference/jobs/x/resultw"],
      ["client.ts", 7, "/v1/ai/device-inference/jobs/y/resultf"],
      ["client.ts", 8, "/v1/ai/device-inference/jobs/w/resulta"]
    ]);
  });
});

describe("round-15 review shapes", () => {
  const deviceRoutes = [
    ...routes,
    { method: "GET", path: "/v1/ai/device-inference/jobs/:id/result" },
    { method: "POST", path: "/v1/ai/device-inference/jobs/:id/result" }
  ];
  function failing(files: Record<string, string>) {
    const folder = mkdtempSync(path.join(directory, "round15-"));
    const written = Object.entries(files).map(([name, source]) => {
      const file = path.join(folder, name);
      writeFileSync(file, source);
      return file;
    });
    return extractWebCalls(written, deviceRoutes)
      .filter((call) => (call.problem ?? findRoute(deviceRoutes, call).status) !== "ok")
      .map((call) => [
        path.basename(call.file),
        call.line,
        call.path.replaceAll(D, "${}"),
        call.method
      ]);
  }

  it("follows a namespace import re-exported by name (`import * as C; export { C, W as WW }`)", () => {
    expect(
      failing({
        "consts.ts": 'export const OK = "/v1/ai/device-inference/jobs/x/result";',
        "wrap.ts": [
          "export function directJob(id: string, step: string) {",
          "  return postJson(`/v1/ai/device-inference/jobs/${id}/${step}`, {});",
          "}"
        ].join("\n"),
        "ns.ts": [
          'import * as C from "./consts";',
          'import * as W from "./wrap";',
          "export { C, W as WW };"
        ].join("\n"),
        "client.ts": [
          'import { C, WW } from "./ns";',
          "export const a = () => getJson(C.OK);",
          'export const b = () => WW.directJob("j", "resultww");'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([["client.ts", 3, "/v1/ai/device-inference/jobs/j/resultww", "POST"]]);
  });

  it("checks methods of an anonymous `export default class`", () => {
    expect(
      failing({
        "anon.ts": [
          "export default class {",
          "  send(step: string) { return postJson(`/v1/ai/device-inference/jobs/x/${step}`, {}); }",
          "}"
        ].join("\n"),
        "client.ts": [
          'import Anon from "./anon";',
          'export const a = () => new Anon().send("resultanon");'
        ].join("\n")
      }).filter(([file]) => file === "client.ts")
    ).toEqual([["client.ts", 2, "/v1/ai/device-inference/jobs/x/resultanon", "POST"]]);
  });

  it("never takes a third-party import for a project helper or fetch; its API-looking paths are checked only as data", () => {
    expect(
      failing({
        "client.ts": [
          'import { postJson, getJson } from "some-external-sdk";',
          'import { fetchJson as apiFetch } from "other-sdk";',
          'export const a = () => postJson("/v1/not-ours/at-all", {});',
          'export const b = () => apiFetch("/v1/also/not/ours");',
          'export const c = () => getJson("/auth/not-ours");'
        ].join("\n")
      })
    ).toEqual([
      ["client.ts", 3, "/v1/not-ours/at-all", undefined],
      ["client.ts", 4, "/v1/also/not/ours", undefined]
    ]);
  });

  it("resolves every workspace package to its TypeScript entry, wherever it lives", () => {
    const from = path.join(process.cwd(), "apps/web/src/main.tsx");
    expect(resolveModule(from, "@grogoni/offline-runtime")).toBe(
      path.join(process.cwd(), "packages/offline-runtime/index.ts")
    );
    expect(resolveModule(from, "@grogoni/ui")).toBe(
      path.join(process.cwd(), "packages/ui/src/index.tsx")
    );
    expect(resolveModule(from, "@grogoni/shared-types")).toBe(
      path.join(process.cwd(), "packages/shared-types/src/index.ts")
    );
    expect(resolveModule(from, "some-external-sdk")).toBeUndefined();
  });
});

describe("round-16 review shapes", () => {
  it("never takes a third-party import for a helper or fetch inside wrappers, held values or namespace/default members", () => {
    const folder = mkdtempSync(path.join(directory, "round16-"));
    const file = path.join(folder, "client.ts");
    writeFileSync(
      file,
      [
        'import { postJson } from "some-sdk";',
        'import * as sdk from "some-sdk";',
        'import sdkDefault from "some-sdk";',
        'import { fetch as sdkFetch, doFetch } from "other-sdk";',
        "export const w = (p: string) => postJson(p, {});",
        'export const a = () => w("/not/ours/wrapped");',
        'export const b = () => sdk.postJson("/not/ours/ns", {});',
        'export const c = () => sdk.fetch("/not/ours/nsfetch");',
        'export const d = () => sdkDefault.getJson("/not/ours/default");',
        'export const e = () => sdkFetch("/not/ours/fetch");',
        'export const f = () => doFetch("/not/ours/dofetch");',
        "const held = postJson;",
        'export const g = () => held("/not/ours/held", {});',
        "export const h = (p: string) => sdkFetch(`/api/${p}`);",
        'export const i = () => h("x/y");',
        "// A project wrapper whose request function is a parameter default is still checked.",
        "export async function sale(id: string, request: typeof getJson = getJson) {",
        "  return request(`/businesses/${id}/invoicez`);",
        "}",
        'export const j = () => sale("b1");'
      ].join("\n")
    );
    const failing = extractWebCalls([file], routes)
      .filter((call) => (call.problem ?? findRoute(routes, call).status) !== "ok")
      .map((call) => [call.line, call.path.replaceAll(D, "${}")]);
    expect(failing).toEqual([
      [18, "/businesses/${}/invoicez"],
      [20, "/businesses/b1/invoicez"]
    ]);
  });
});

describe("round-17 review shapes", () => {
  it("keeps the helper's method in wrappers that call it through an alias or a parameter default", () => {
    const folder = mkdtempSync(path.join(directory, "round17-"));
    const file = path.join(folder, "client.ts");
    // The project's helper module, so the import resolves (an unresolvable one is third-party).
    writeFileSync(
      path.join(folder, "api-helpers.ts"),
      "export function postJson(path: string, body: unknown): Promise<unknown> { return Promise.resolve({ path, body }); }"
    );
    writeFileSync(
      file,
      [
        'import { postJson as post, postJson } from "./api-helpers";',
        "export const w1 = (p: string) => post(p, {});",
        "export async function w2(p: string, request = postJson) {",
        "  return request(p, {});",
        "}",
        "export const w3 = (p: string) => postJson(p, {});",
        'export const c1 = () => w1("/auth/sessions");',
        'export const c2 = () => w2("/auth/sessions");',
        'export const c3 = () => w3("/auth/sessions");',
        'export const d1 = () => post("/auth/sessions", {});'
      ].join("\n")
    );
    const results = extractWebCalls([file], [{ method: "GET", path: "/auth/sessions" }])
      .filter((call) => call.path === "/auth/sessions")
      .map((call) => [
        call.line,
        call.method,
        findRoute([{ method: "GET", path: "/auth/sessions" }], call).status
      ]);
    expect(results).toEqual([
      [7, "POST", "method_mismatch"],
      [8, "POST", "method_mismatch"],
      [9, "POST", "method_mismatch"],
      [10, "POST", "method_mismatch"]
    ]);
  });

  it("checks completePosSale's calls at the PosTerminal call site as POST", () => {
    const web = path.join(process.cwd(), "apps/web/src");
    const calls = extractWebCalls(
      [path.join(web, "PosTerminal.tsx"), path.join(web, "pos-sale.ts")],
      routes
    ).filter(
      (call) => call.file.endsWith("PosTerminal.tsx") && /\/(invoices|payments)/u.test(call.path)
    );
    expect(calls.length).toBe(3);
    expect(calls.every((call) => call.method === "POST")).toBe(true);
  });
});

describe("round-18 review shapes", () => {
  it("reads `{ method }` for apiFetch and fetch reached through an alias or a parameter default", () => {
    const folder = mkdtempSync(path.join(directory, "round18-"));
    writeFileSync(
      path.join(folder, "api-helpers.ts"),
      [
        "export function apiFetch(path: string, init?: RequestInit): Promise<Response> { return Promise.resolve(new Response(path + String(init))); }",
        "export function getJson(path: string): Promise<unknown> { return Promise.resolve(path); }"
      ].join("\n")
    );
    const file = path.join(folder, "client.ts");
    writeFileSync(
      file,
      [
        'import { apiFetch as af, apiFetch, getJson as get } from "./api-helpers";',
        'export const p2 = (p: string) => af(p, { method: "PUT" });',
        'export const cp2 = () => p2("/auth/sessions");',
        'export async function p3(p: string, request = apiFetch) { return request(p, { method: "PUT" }); }',
        'export const cp3 = () => p3("/auth/sessions");',
        'export const dp2 = () => af("/auth/sessions", { method: "PUT" });',
        'export async function f1(p: string, request = fetch) { return request(p, { method: "PUT" }); }',
        'export const cf1 = () => f1("/api/auth/sessions");',
        "export const g1 = (p: string) => get(p);",
        'export const cg1 = () => g1("/auth/sessions");'
      ].join("\n")
    );
    const route = [{ method: "GET", path: "/auth/sessions" }];
    const results = extractWebCalls([file], route)
      .filter((call) => path.basename(call.file) === "client.ts")
      .map((call) => [call.line, call.method, call.problem ?? findRoute(route, call).status]);
    expect(results).toEqual([
      [3, "PUT", "method_mismatch"],
      [5, "PUT", "method_mismatch"],
      [6, "PUT", "method_mismatch"],
      [8, "PUT", "method_mismatch"],
      [10, "GET", "ok"]
    ]);
  });
});

describe("round-19 review shapes", () => {
  it("never takes a held or defaulted member of a third-party import for a helper or fetch", () => {
    const folder = mkdtempSync(path.join(directory, "round19-"));
    const file = path.join(folder, "client.ts");
    writeFileSync(
      file,
      [
        'import * as sdk from "some-third-party-sdk";',
        "export async function c1(p: string, req = sdk.fetch) { return req(p); }",
        'export const cc1 = () => c1("/api/auth/nonexistent-zz");',
        "const f = sdk.postJson;",
        'export const c2 = () => f("/auth/nonexistent-yy");',
        'export const c3 = () => sdk.postJson("/auth/nonexistent-xx");',
        "const g = sdk.fetch;",
        'export const c4 = () => g("/api/auth/sessions", { method: "PUT" });',
        "// A project-side member (window.fetch) is still fetch.",
        "const wf = window.fetch;",
        'export const c5 = () => wf("/api/auth/nonexistent-ww");'
      ].join("\n")
    );
    const failing = extractWebCalls([file], routes)
      .filter((call) => (call.problem ?? findRoute(routes, call).status) !== "ok")
      .map((call) => [call.line, call.path]);
    expect(failing).toEqual([[11, "/auth/nonexistent-ww"]]);
  });
});

describe("round-20 review shapes", () => {
  it("treats any receiver chain rooted in a third-party import as third-party, and project chains as the project's", () => {
    const folder = mkdtempSync(path.join(directory, "round20-"));
    writeFileSync(
      path.join(folder, "api-helpers.ts"),
      "export function postJson(path: string, body?: unknown): Promise<unknown> { return Promise.resolve({ path, body }); }"
    );
    const file = path.join(folder, "client.ts");
    writeFileSync(
      file,
      [
        'import * as tauri from "@tauri-apps/api";',
        'import sdk from "some-third-party-sdk";',
        'import * as api from "./api-helpers";',
        'export const n1 = () => tauri.http.fetch("/api/auth/nonexistent-n1");',
        'export const n2 = () => sdk.default.postJson("/auth/nonexistent-n2");',
        "const h = tauri.http.fetch;",
        'export const n4 = () => h("/api/auth/nonexistent-n4");',
        "const alias = sdk;",
        'export const n5 = () => alias.postJson("/auth/nonexistent-n5");',
        'export const n7 = () => (sdk as any).postJson("/auth/nonexistent-n7");',
        'export const p1 = () => (api as typeof api).postJson("/auth/nonexistent-p1");',
        "const projectAlias = api;",
        'export const p2 = () => projectAlias.postJson("/auth/nonexistent-p2");'
      ].join("\n")
    );
    const failing = extractWebCalls([file], routes)
      .filter((call) => path.basename(call.file) === "client.ts")
      .filter((call) => (call.problem ?? findRoute(routes, call).status) !== "ok")
      .map((call) => [call.line, call.path, call.method]);
    expect(failing).toEqual([
      [11, "/auth/nonexistent-p1", "POST"],
      [13, "/auth/nonexistent-p2", "POST"]
    ]);
  });
});
