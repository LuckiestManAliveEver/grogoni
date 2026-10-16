// Everything is an API (docs/architecture/governed-tool-runtime.md). This check keeps it true:
//   1. every API path a client calls (web app, Android app) exists on the production API;
//   2. every /businesses/:id/<group> route group is classified in
//      packages/tool-core/src/contracts/api-route-coverage.json as covered by a tool, exempt, or a
//      known gap, and every tool it names exists.
// Run: pnpm check:api-routes. Exit code 1 on any failure.
//
// What it resolves. Request sites: API helpers (postJson, getJson, apiFetch, ...), also under an
// import alias or held in a variable or parameter default (`request: PosJsonRequest = postJson`);
// browser calls (fetch, window.fetch, and any callee named like fetch/fetcher/doFetch that is not
// a function declared in the project or imported from a third-party package; sendBeacon; new
// Request, EventSource, WebSocket; XMLHttpRequest.open); links to the API base; and every key of a
// cache-key helper. Wrappers: a function or method (receiver `this`, an object literal, or an
// instance of a class that declares it; in the file or imported, including default exports,
// re-exports under another name, and useCallback/useMemo callbacks) whose request path depends on
// one of its parameters, in any position, directly or through a local constant, is a request site
// too: each call is checked by resolving the wrapper's path with its parameters bound to that
// call's arguments (an object argument's properties too, for `input.base`), and a method parameter
// is read from the call. One level of wrapper is followed, plus wrappers declared inside a wrapper
// whose path uses the outer wrapper's parameters (`const post = (path) =>
// input.doFetch(`${input.base}/x/${path}`)`), resolved with both calls bound. Names follow
// JavaScript's scopes: a called name, a constant or a receiver means the declaration in scope
// where it is written (a parameter, destructured or not, a loop or catch variable, or a local
// declaration hides outer ones); an imported name means the export it imports (`export function`,
// `export const`, `export class`, `export { x as y }`, `export default`, anonymous ones too,
// re-exports, and `export * as ns from` as a namespace), and an import from a module the check
// cannot resolve (a third-party package) is never taken for a request helper, fetch, wrapper or
// builder, whatever it is called (an unmistakable API path passed to it is still checked as data,
// below); `this.send` means the method of the enclosing class or object (or of the class it
// extends, in the same file); `new C().send`, `c.send` for `const c = new C()` and the static
// `C.send` mean that class's method (C a class declaration or expression, declared or imported, or
// `W.C` for a namespace); `api.send` and `W.api.send` the method of the object literal held there
// (here or imported, through `as`/`satisfies`); and `W.send` for `import * as W` that module's
// export. A same-named declaration elsewhere never stands in. Unmistakable API URLs (on the API
// base, under /v1/, or under /businesses/<dynamic id>/) are also checked wherever they appear as
// data, including builder calls (`this.path(id, "/x")`). Paths are resolved through literals,
// templates, concatenation, [...].join("/"), ternaries, `a ?? b`, `.replace()`/`.trim()` on a base
// (and `.replace(/...$/, "/v1/x")` as a base ending in /v1/x), String()/encodeURI()/new URL(x),
// constants and nested endpoint objects (literal keys too), in the file or imported by module
// (relative paths and workspace packages, each at its TypeScript entry: its `exports` source,
// src/index or a root index, through re-exports, including namespace and default imports),
// composed constants, and builder functions and methods (every `return`, with the call's arguments
// bound; a property of an object a builder returns too). A later path piece that is a finite set
// of literal words (a constant, a ternary of literals, a `"import" | "sync"` parameter or local
// type alias) is expanded into every combination, up to 32; any other later piece is a dynamic
// segment. The API base is readApiBaseUrl() or import.meta.env.VITE_API_BASE_URL / VITE_API_URL.
// Methods are read from the options object in scope (`as const`, `{ method }`, method tables). A
// trailing expression glued to a word is a query or a sub-path, so the rest is matched as a prefix
// (a glued path constant is resolved). A path counts only if one segment is a fixed word.
// - A name declared in the project that cannot be evaluated (a missing export, or a missing key of
// a declared constant or endpoint object; a key missing from an object a builder returns is
// dynamic) fails the
//   check unless listed in clientPathExceptions.
// - Raw browser calls are relative to the web origin: a relative API path must start with /api/
//   (or use the API base), and `new URL("/x", readApiBaseUrl())` drops the /api base. A raw call
//   on a base the check cannot see (a parameter, a config value) may be any origin and is not
//   checked; a wrapper's call sites are, when they pass the API base.
// What it cannot see: parameters, props, loop variables and computed keys (`PATHS[k]`) are dynamic
// outside a bound wrapper or builder call; a path dynamic from its first segment
// (`/v1/${anything}`); a removed route whose path a parameter route still matches
// (`/v1/conversations/recycle-bin` vs `/v1/conversations/:id`); a path outside /v1/ and
// /businesses/<id>/ that only reaches the API through a function it does not recognize (for
// example a dependency typed by an interface, `this.deps.cloud("/auth/x")`); wrappers more than
// one level deep, with destructured parameters, or whose base is a property of an argument passed
// in a variable rather than as an object literal; a base held in a class field and read back
// through `this` (the literal itself is checked as a prefix); functions returned by a getter;
// members an object gets from a spread (`{ ...baseApi }.send`); a namespace inside a namespace
// (`W.ns.send`); a member of a third-party import reached through more than one alias (`const a =
// sdk; const b = a`), a name destructured from it (`const { http } = tauri`), or a call's result
// (`sdk.create().postJson`) is taken for the project's own helper or fetch, so such a call is
// reported rather than ignored; reassigned variables (the first value is used); `var` declared in
// a nested block (treated as block-scoped); `this` inside a plain `function`, and methods
// inherited from a class in another module; paths built by mutating a URL object (`url.pathname +=
// ...`) or inside HTML strings; and Android calls other than string literals (concatenated across
// lines too) in files that define request(), or strings built on GROGONI_API_ORIGIN (or a val
// holding it): a path kept in its own val, or built with OkHttp's addPathSegments, is not read.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface RouteEntry {
  method: string;
  path: string;
}

export interface ClientCall {
  file: string;
  line: number;
  /** Path with each dynamic segment replaced by "\u0000". */
  path: string;
  /** HTTP method when the call site states it; undefined when it cannot be known statically. */
  method?: string | undefined;
  /** True when the path is `${base}/tail`: only the tail is known, matched as a route suffix. */
  suffixOnly: boolean;
  /** True for a path base kept in a variable and extended later: matched as a route prefix. */
  prefixOnly?: boolean | undefined;
  /** A defect found without route matching: the call cannot reach the API as written. */
  problem?: "unresolved" | "bypasses_api_base" | "url_drops_api_base" | undefined;
}

export interface CoverageContract {
  businessRouteGroups: Record<
    string,
    { status: "tool"; tools: string[] } | { status: "exempt" | "gap"; reason: string }
  >;
  clientPathExceptions: { file: string; path: string; reason: string }[];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** API helpers: their path argument is relative to the API base (lib/api.ts readApiBaseUrl). */
const methodByHelper: Record<string, string | undefined> = {
  postJson: "POST",
  patchJson: "PATCH",
  putJson: "PUT",
  deleteJson: "DELETE",
  getJson: "GET",
  fetchFreshJson: "GET",
  apiFetch: undefined,
  apiCloudFetch: undefined
};
const apiHelpers = new Set(Object.keys(methodByHelper));
/** Browser calls whose path argument is relative to the web origin, not the API. */
const rawCallees = new Set(["fetch", "sendBeacon"]);
const optionCallers = new Set(["apiFetch", "apiCloudFetch", "fetch"]);
/** Helpers that take a path prefix as a cache key; their arguments must prefix a route. */
const cacheKeyCallees = new Set(["useApiMutationRevision", "invalidateApiCacheForMutation"]);
/** In-app navigation: a path here is a screen, not an API call. */
const navigationCallees = new Set([
  "pushState",
  "replaceState",
  "assign",
  "replace",
  "navigate",
  "redirect",
  "openModulePath"
]);
const navigationAttributes = new Set(["href", "to", "action"]);
/** The API base itself: `${readApiBaseUrl()}/x` is an absolute API URL. */
const apiBasePattern = /readApiBaseUrl|api(?:Base|Origin|Host|Url)|API_(?:BASE|ORIGIN|URL)/iu;
/** Another absolute base (Supabase, a CDN, the web origin): not this API. */
const externalBasePattern = /base_?url|origin|host|SUPABASE|https?:/iu;

function segments(value: string) {
  return value.split("/").filter(Boolean);
}

function segmentMatches(pattern: string, actual: string) {
  if (pattern.startsWith(":") || pattern === "*") return true;
  // A whole dynamic segment (`/${kind}`) can hold any fixed word, so it matches any segment.
  if (actual === "\u0000") return true;
  // A partly dynamic segment (`/v${n}`) can only fill a parameter.
  if (actual.includes("\u0000")) return false;
  return pattern === actual;
}

/** Whether a client path (dynamic segments as \u0000) can reach a route path pattern. */
export function routeMatches(
  route: string,
  call: string,
  suffixOnly = false,
  prefixOnly = false
): boolean {
  const routeParts = segments(route);
  const callParts = segments(call);
  if (prefixOnly)
    return (
      routeParts.length >= callParts.length &&
      callParts.every((part, index) => segmentMatches(routeParts[index]!, part))
    );
  if (routeParts.at(-1) === "*") {
    const fixed = routeParts.slice(0, -1);
    return (
      callParts.length >= fixed.length &&
      fixed.every((part, index) => segmentMatches(part, callParts[index]!))
    );
  }
  if (suffixOnly ? routeParts.length < callParts.length : routeParts.length !== callParts.length)
    return false;
  const aligned = suffixOnly ? routeParts.slice(routeParts.length - callParts.length) : routeParts;
  if (!aligned.every((part, index) => segmentMatches(part, callParts[index]!))) return false;
  // A tail with an unknown base must share at least one fixed word with the route; otherwise any
  // one-segment tail would match any route ending in a parameter.
  return (
    !suffixOnly ||
    callParts.some((part, index) => !part.includes("\u0000") && aligned[index] === part)
  );
}

export function findRoute(routes: RouteEntry[], call: ClientCall) {
  const candidates = routes.filter((route) =>
    routeMatches(route.path, call.path, call.suffixOnly, call.prefixOnly)
  );
  if (candidates.length === 0) return { status: "missing" as const, methods: [] };
  const methods = [...new Set(candidates.map((route) => route.method))];
  if (call.method !== undefined && !methods.includes(call.method))
    return { status: "method_mismatch" as const, methods };
  return { status: "ok" as const, methods };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "dist", "build"].includes(entry.name) ? [] : sourceFiles(full);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)
      ? [full]
      : [];
  });
}

function calleeName(call: ts.CallExpression | ts.NewExpression) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return "";
}

/** Literals used to test a path (`p.startsWith("/auth/")`, `p === "/x"`) are not calls. */
function isComparison(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent))
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken
    ].includes(parent.operatorToken.kind);
  if (ts.isCaseClause(parent)) return true;
  return (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    ["startsWith", "endsWith", "includes", "match", "test"].includes(parent.expression.name.text)
  );
}

/** A path used for in-app navigation (`history.pushState`, `<a href>`, `location.href =`). */
function isNavigation(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      (ts.isConditionalExpression(current.parent) && current.parent.condition !== current) ||
      ts.isJsxExpression(current.parent))
  )
    current = current.parent;
  const parent = current.parent;
  if (parent === undefined) return false;
  if (
    ts.isCallExpression(parent) &&
    (navigationCallees.has(calleeName(parent)) || calleeName(parent) === "open")
  ) {
    // `replace` and `assign` navigate only on `location`; String.prototype.replace does not.
    const name = calleeName(parent);
    if (name !== "replace" && name !== "assign") return true;
    return (
      ts.isPropertyAccessExpression(parent.expression) &&
      /location$/u.test(parent.expression.expression.getText())
    );
  }
  if (ts.isJsxAttribute(parent) && navigationAttributes.has(parent.name.getText())) return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    /(?:^|\.)(?:href|location)$/u.test(parent.left.getText())
  );
}

type Piece = { text: string } | { expression: ts.Expression };

/** Flattens `"/a/" + id + "/b"` and `` `/a/${id}/b` `` into literal text and expressions. */
function pieces(node: ts.Node): Piece[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [{ text: node.text }];
  // ["", "businesses", id, "documents"].join("/")
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(node.expression.expression) &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]!) &&
    node.arguments[0].text === "/"
  ) {
    const joined: Piece[] = [];
    node.expression.expression.elements.forEach((element, index) => {
      if (index > 0) joined.push({ text: "/" });
      joined.push(
        ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)
          ? { text: element.text }
          : { expression: element as ts.Expression }
      );
    });
    return joined;
  }
  if (ts.isTemplateExpression(node))
    return [
      // An empty head (`${base}/x`) is omitted so the base is the first piece.
      ...(node.head.text === "" ? [] : [{ text: node.head.text }]),
      ...node.templateSpans.flatMap((span): Piece[] => [
        // `${"documents"}` is a literal word, not a dynamic segment.
        ts.isStringLiteral(span.expression) || ts.isNoSubstitutionTemplateLiteral(span.expression)
          ? { text: span.expression.text }
          : { expression: span.expression },
        { text: span.literal.text }
      ])
    ];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = pieces(node.left);
    const right = pieces(node.right);
    // `ROOT + SUB`, `API + p`: both operands are pieces to resolve.
    return [...(left ?? [{ expression: node.left }]), ...(right ?? [{ expression: node.right }])];
  }
  return null;
}

/** What an expression evaluates to, as far as API paths go. */
/** `open`: a trailing expression was dropped, so more may follow; match as a prefix. */
type Resolved =
  | { kind: "path"; text: string; open?: boolean }
  | { kind: "api"; text: string; open?: boolean }
  | { kind: "suffix"; text: string; open?: boolean }
  | { kind: "apiBase" }
  | { kind: "external" }
  | { kind: "dynamic" }
  | { kind: "unresolved"; name: string };

interface ModuleIndex {
  source: ts.SourceFile;
  file: string;
  /** Every variable and parameter by name; parameters have no value unless they have a default. */
  values: Map<
    string,
    {
      position: number;
      /** The node the declaration is visible in (its block, function, loop or catch). */
      scope: ts.Node;
      value: ts.Expression | undefined;
      parameter: boolean;
      type: ts.TypeNode | undefined;
    }[]
  >;
  /** Every function declared in the module, nested ones included. */
  functions: FunctionNode[];
  /** Every class and object-literal method (`this.send`, `api.post`), each its own node. */
  methods: FunctionNode[];
  exported: Map<string, ExportedValue>;
  imports: Map<string, { module: string; name: string }>;
  /** `export * from "./x"` and `export { a as b } from "./x"`. */
  reExports: { module: string; names: Map<string, string> | "*" }[];
  /** `export * as ns from "./x"`: the name and the module it stands for. */
  namespaceExports: Map<string, string>;
  /**
   * Functions that pass a parameter to a request, by their declaration node: a call finds its
   * wrapper by resolving the callee to a declaration (scope, import or member), never by name.
   */
  wrapperByNode: Map<ts.Node, Wrapper>;
}

type FunctionNode = ts.SignatureDeclaration & { body?: ts.Node | undefined };
/** What a module exports under a name: a value, a function, a class, or a local name. */
type ExportedValue = ts.Expression | ts.SignatureDeclaration | ts.ClassDeclaration;

interface Wrapper {
  /** The wrapping function, its module, and the path argument of the request it makes. */
  fn: ts.SignatureDeclaration & { body?: ts.Node | undefined };
  index: ModuleIndex;
  argument: ts.Expression;
  callee: string;
  method: string | undefined;
  /** Which argument carries the method, when the wrapper passes `{ method }` through. */
  methodParameter: number | undefined;
  /** Further request sites in the same function (one per request it makes). */
  extra: Wrapper[];
  /**
   * A call to a wrapper declared inside this one (`post("result")` inside serveDeviceJobs,
   * where post's base is `input.base`): resolved with both frames bound.
   */
  nested?: { inner: Wrapper; call: ts.CallExpression } | undefined;
}

/** A browser fetch under any local name: fetch, window.fetch, an injected fetcher or doFetch. */
function isRawCallee(name: string) {
  return (
    // A third-party import (`external:` from calleeIdentity) is never fetch, whatever its name.
    !name.startsWith("external:") &&
    !apiHelpers.has(name) &&
    (rawCallees.has(name) || /^(?:do)?[Ff]etch(?:er)?$|[a-z]Fetch(?:er)?$/u.test(name))
  );
}

/** Workspace packages by name (`@grogoni/shared-types` -> packages/shared-types/src/index.ts). */
const workspacePackages = (() => {
  const packages = new Map<string, string>();
  const directory = path.join(root, "packages");
  if (!existsSync(directory)) return packages;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const folder = path.join(directory, entry.name);
    const manifest = path.join(folder, "package.json");
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const { name, exports } = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
      exports?: unknown;
    };
    // The TypeScript source the package is built from: its `exports` entry when that is source
    // (`"./src/index.tsx"`), else src/index or a root index (`packages/offline-runtime/index.ts`).
    const declared =
      typeof exports === "string"
        ? exports
        : typeof exports === "object" &&
            exports !== null &&
            typeof (exports as Record<string, unknown>)["."] === "string"
          ? ((exports as Record<string, unknown>)["."] as string)
          : undefined;
    const entryFile = [
      ...(declared !== undefined && /\.tsx?$/u.test(declared) ? [path.join(folder, declared)] : []),
      path.join(folder, "src", "index.ts"),
      path.join(folder, "src", "index.tsx"),
      path.join(folder, "index.ts"),
      path.join(folder, "index.tsx")
    ].find((candidate) => existsSync(candidate));
    if (name !== undefined && entryFile !== undefined) packages.set(name, entryFile);
  }
  return packages;
})();

export function resolveModule(from: string, specifier: string): string | undefined {
  if (workspacePackages.has(specifier)) return workspacePackages.get(specifier);
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/u, ""));
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) =>
    existsSync(candidate)
  );
}

function indexModule(source: ts.SourceFile): ModuleIndex {
  const index: ModuleIndex = {
    source,
    file: source.fileName,
    values: new Map(),
    functions: [],
    exported: new Map(),
    imports: new Map(),
    reExports: [],
    namespaceExports: new Map(),
    methods: [],
    wrapperByNode: new Map()
  };
  const addValue = (
    declaration: ts.Node,
    name: string,
    value: ts.Expression | undefined,
    parameter: boolean,
    type?: ts.TypeNode
  ) => {
    const list = index.values.get(name) ?? [];
    list.push({
      position: declaration.getStart(),
      scope: declarationScope(declaration),
      value,
      parameter,
      type
    });
    index.values.set(name, list);
  };
  const isExported = (node: ts.Node) =>
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) index.imports.set(clause.name.text, { module, name: "default" });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        index.imports.set(bindings.name.text, { module, name: "*" });
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          index.imports.set(element.name.text, {
            module,
            name: (element.propertyName ?? element.name).text
          });
    }
    if (ts.isExportAssignment(statement)) {
      index.exported.set("default", statement.expression);
      // `export default (id, step) => ...`: an anonymous function, a wrapper like any other.
      const fn = functionValue(statement.expression);
      if (fn !== undefined) index.functions.push(fn);
    }
    // `export { x, y as z }` with no `from`: the export is the local name, resolved in this module.
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      !statement.isTypeOnly &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName ?? element.name;
        if (!element.isTypeOnly && ts.isIdentifier(local) && ts.isIdentifier(element.name))
          index.exported.set(element.name.text, local);
      }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamespaceExport(clause)) {
        // `export * as ns from "./x"` exports one name, the whole module; not its members.
        if (ts.isIdentifier(clause.name))
          index.namespaceExports.set(clause.name.text, statement.moduleSpecifier.text);
        continue;
      }
      index.reExports.push({
        module: statement.moduleSpecifier.text,
        names:
          clause !== undefined && ts.isNamedExports(clause)
            ? new Map(
                clause.elements.map((element) => [
                  element.name.text,
                  (element.propertyName ?? element.name).text
                ])
              )
            : "*"
      });
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && isExported(node)) {
      if (node.name !== undefined) index.exported.set(node.name.text, node);
      // `export default class { ... }` too, named or not.
      if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0)
        index.exported.set("default", node);
    }
    // `export default function (id, step) { ... }` has no name but is the default export.
    if (
      ts.isFunctionDeclaration(node) &&
      node.name === undefined &&
      node.body !== undefined &&
      (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0
    ) {
      index.functions.push(node);
      index.exported.set("default", node);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      if (node.body !== undefined) index.functions.push(node);
      if (isExported(node)) index.exported.set(node.name.text, node);
      if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0)
        index.exported.set("default", node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const value = node.initializer;
      // A declaration without a value (`for (const path of paths)`, `let x;`) is dynamic, like a
      // parameter: only a name with a value we fail to evaluate is "unresolved".
      addValue(node, node.name.text, value, value === undefined, node.type);
      if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
        index.functions.push(value);
      }
      // `const load = useCallback((path) => getJson(path), [])`: the callback is the function.
      if (
        value &&
        ts.isCallExpression(value) &&
        ["useCallback", "useMemo"].includes(calleeName(value)) &&
        value.arguments[0] !== undefined &&
        (ts.isArrowFunction(value.arguments[0]) || ts.isFunctionExpression(value.arguments[0]))
      ) {
        index.functions.push(value.arguments[0]);
      }
      if (value && isExported(node.parent.parent)) index.exported.set(node.name.text, value);
    }
    if (ts.isMethodDeclaration(node) && node.body !== undefined) index.methods.push(node);
    if (
      (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      index.methods.push(node.initializer);
    if (ts.isParameter(node) && ts.isIdentifier(node.name))
      addValue(node, node.name.text, node.initializer, true, node.type);
    // Destructured names (`const { base } = input`, `({ post }) =>`) are dynamic, and hide outer
    // declarations of the same name.
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && !ts.isIdentifier(node.name))
      for (const name of boundNames(node.name)) addValue(node, name, undefined, true);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return index;
}

/** The expressions a function returns: its arrow body, or every `return <expr>`. */
function returnedExpressions(fn: ts.SignatureDeclaration & { body?: ts.Node | undefined }) {
  const body = fn.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body as ts.Expression];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

class PathResolver {
  private readonly modules = new Map<string, ModuleIndex>();

  constructor(sources: ts.SourceFile[]) {
    for (const source of sources) this.modules.set(source.fileName, indexModule(source));
    for (const index of this.modules.values()) this.findWrappers(index);
  }

  module(file: string) {
    return this.load(file)!;
  }

  /** A module by file, indexed on first use (workspace packages are outside the scanned set). */
  private load(file: string): ModuleIndex | undefined {
    const known = this.modules.get(file);
    if (known !== undefined) return known;
    if (!existsSync(file)) return undefined;
    const index = indexModule(
      ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    );
    this.modules.set(file, index);
    return index;
  }

  /** An exported binding, following `export * from` and `export { a } from` chains. */
  exportedValue(
    target: ModuleIndex,
    name: string,
    seen = new Set<string>()
  ): { index: ModuleIndex; value: ExportedValue } | undefined {
    if (seen.has(`${target.file}#${name}`)) return undefined;
    seen.add(`${target.file}#${name}`);
    const own = target.exported.get(name);
    if (own !== undefined) return { index: target, value: own };
    for (const reExport of target.reExports) {
      const original = reExport.names === "*" ? name : reExport.names.get(name);
      if (original === undefined) continue;
      const file = resolveModule(target.file, reExport.module);
      const next = file === undefined ? undefined : this.load(file);
      const found = next === undefined ? undefined : this.exportedValue(next, original, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The module `export * as name from` stands for, here or through `export *` / named barrels. */
  private namespaceExport(
    target: ModuleIndex,
    name: string,
    seen = new Set<string>()
  ): ModuleIndex | undefined {
    if (seen.has(`${target.file}#${name}`)) return undefined;
    seen.add(`${target.file}#${name}`);
    const own = target.namespaceExports.get(name);
    if (own !== undefined) {
      const file = resolveModule(target.file, own);
      return file === undefined ? undefined : this.load(file);
    }
    // `import * as C from "./x"; export { C }` (or `export { C as D }`): the module C names.
    const local = target.exported.get(name);
    if (local !== undefined && ts.isIdentifier(local)) {
      const binding = target.imports.get(local.text);
      if (binding !== undefined && binding.name === "*") {
        const file = resolveModule(target.file, binding.module);
        return file === undefined ? undefined : this.load(file);
      }
      if (binding !== undefined) {
        // `import { ns } from "./barrel"; export { ns }`: follow that import on.
        const file = resolveModule(target.file, binding.module);
        const next = file === undefined ? undefined : this.load(file);
        const found =
          next === undefined ? undefined : this.namespaceExport(next, binding.name, seen);
        if (found !== undefined) return found;
      }
    }
    for (const reExport of target.reExports) {
      const original = reExport.names === "*" ? name : reExport.names.get(name);
      if (original === undefined) continue;
      const file = resolveModule(target.file, reExport.module);
      const next = file === undefined ? undefined : this.load(file);
      const found = next === undefined ? undefined : this.namespaceExport(next, original, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The module an import binds to, by its path (a namespace re-export counts as the module). */
  private importTarget(index: ModuleIndex, local: string) {
    const binding = index.imports.get(local);
    if (binding === undefined) return undefined;
    // Only the module the specifier names: a package the check cannot resolve stays unresolved,
    // never stood in for by a project module that happens to export the same name.
    const file = resolveModule(index.file, binding.module);
    const target = file === undefined ? undefined : this.load(file);
    // `import { ns } from "./barrel"` where the barrel has `export * as ns from "./x"`.
    if (target !== undefined && binding.name !== "*") {
      const namespace = this.namespaceExport(target, binding.name);
      if (namespace !== undefined) return { target: namespace, name: "*" };
    }
    return target === undefined ? undefined : { target, name: binding.name };
  }

  /**
   * What a called identifier really is: an import alias (`postJson as post`) is the imported
   * name; a variable or parameter whose value or default is a helper (`request = postJson`,
   * `fetcher = options.fetcher ?? globalThis.fetch`) is that helper. `project` is true when the
   * name is a function declared in the project, which is never taken for fetch by its name.
   */
  calleeIdentity(index: ModuleIndex, callee: ts.Expression): { name: string; project: boolean } {
    if (!ts.isIdentifier(callee)) {
      if (!ts.isPropertyAccessExpression(callee)) return { name: "", project: false };
      return { name: this.memberIdentity(index, callee), project: false };
    }
    let name = callee.text;
    // What the name is where it is called: a local function, an import, or a value (a parameter
    // like `doFetch = fetch`) to follow. A same-named function elsewhere in the file is not it.
    const binding = bindingOf(callee);
    if (binding?.kind === "function") return { name, project: true };
    if (binding?.kind === "import") {
      const imported = this.importTarget(index, name);
      // A package the check cannot resolve (third-party) is not one of the project's request
      // helpers or fetch, whatever it is called: its name matches nothing.
      if (imported === undefined) return { name: `external:${name}`, project: false };
      return {
        name: imported.name,
        project: this.importedFunction(index, name) !== undefined
      };
    }
    // Follow a value or default to the helper it names, a few steps.
    let value: ts.Expression | undefined = this.valueOf(index, name, callee.getStart())?.value;
    for (let step = 0; step < 4 && value !== undefined; step++) {
      while (
        ts.isParenthesizedExpression(value) ||
        ts.isAsExpression(value) ||
        ts.isNonNullExpression(value)
      )
        value = value.expression;
      if (
        ts.isBinaryExpression(value) &&
        (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        value = value.right;
        continue;
      }
      // `const f = sdk.postJson`, `req = window.fetch`: the member, unless it is a third-party one.
      if (ts.isPropertyAccessExpression(value))
        return { name: this.memberIdentity(index, value), project: false };
      if (!ts.isIdentifier(value)) break;
      name = value.text;
      const named = bindingOf(value);
      if (named?.kind === "import") {
        const imported = this.importTarget(index, name);
        return imported === undefined
          ? { name: `external:${name}`, project: false }
          : { name: imported.name, project: false };
      }
      if (named?.kind === "function") return { name, project: true };
      value = this.valueOf(index, name, value.getStart())?.value;
    }
    return { name, project: false };
  }

  /** The function a name means where it is written: declared in scope, or imported. */
  functionAt(
    index: ModuleIndex,
    identifier: ts.Identifier,
    depth = 0
  ): { index: ModuleIndex; fn: FunctionNode } | undefined {
    const binding = bindingOf(identifier);
    if (binding?.kind === "function") return { index, fn: binding.fn };
    if (binding?.kind === "import") return this.importedFunction(index, identifier.text, depth);
    return undefined;
  }

  /** The function an imported name refers to, followed through the module that exports it. */
  importedFunction(
    index: ModuleIndex,
    name: string,
    depth = 0
  ): { index: ModuleIndex; fn: FunctionNode } | undefined {
    // Barrels that import and re-export a name (`import { a } ...; export { a }`) can cycle.
    if (depth > 8) return undefined;
    const imported = this.importTarget(index, name);
    return this.functionOfExport(
      imported === undefined ? undefined : this.exportedValue(imported.target, imported.name),
      depth + 1
    );
  }

  /** The function an export is: declared, a held arrow or callback, or a local name for one. */
  private functionOfExport(
    found: { index: ModuleIndex; value: ExportedValue } | undefined,
    depth = 0
  ): { index: ModuleIndex; fn: FunctionNode } | undefined {
    if (found === undefined || ts.isClassDeclaration(found.value)) return undefined;
    if (ts.isFunctionLike(found.value))
      return { index: found.index, fn: found.value as FunctionNode };
    // `export default send;` or `export { send }` naming a function in that module.
    if (ts.isIdentifier(found.value)) return this.functionAt(found.index, found.value, depth);
    const fn = functionValue(found.value as ts.Expression);
    return fn === undefined ? undefined : { index: found.index, fn };
  }

  /**
   * The name a member stands for: `sdk.postJson` on a namespace or default import of a package the
   * check cannot resolve is that package's (`external:`), never the project's helper or fetch.
   */
  memberIdentity(index: ModuleIndex, member: ts.PropertyAccessExpression): string {
    return this.isThirdParty(index, member.expression)
      ? `external:${member.name.text}`
      : member.name.text;
  }

  /**
   * Whether an expression is rooted in a namespace or default import of a module the check
   * cannot resolve: `sdk`, `sdk.default`, `tauri.http`, `(sdk as any)`, `sdk!`, `sdk["x"]`, or a
   * `const alias = sdk` (followed one step).
   */
  private isThirdParty(index: ModuleIndex, expression: ts.Expression, depth = 0): boolean {
    let root: ts.Expression = expression;
    for (;;) {
      root = unwrapExpression(root);
      if (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))
        root = root.expression;
      else break;
    }
    if (!ts.isIdentifier(root)) return false;
    const binding = bindingOf(root);
    if (binding?.kind === "import") return this.importTarget(index, root.text) === undefined;
    if (binding?.kind !== "other" || depth > 0) return false;
    const held = this.valueOf(index, root.text, root.getStart());
    return (
      held?.value !== undefined &&
      !held.parameter &&
      this.isThirdParty(held.index, held.value, depth + 1)
    );
  }

  /** What a call is for reading its method: its resolved identity, else its callee's name. */
  helperNameOf(index: ModuleIndex, call: ts.CallExpression | ts.NewExpression): string {
    if (!ts.isCallExpression(call)) return calleeName(call);
    return this.calleeIdentity(index, call.expression).name || calleeName(call);
  }

  /** The method a request call states, with each enclosing call named by its identity. */
  methodAt(index: ModuleIndex, node: ts.Node): string | undefined {
    return statedMethod(node, (call) => this.helperNameOf(index, call));
  }

  /** The class a name means where it is written: declared in the file, or imported. */
  classAt(
    index: ModuleIndex,
    identifier: ts.Identifier,
    depth = 0
  ): { index: ModuleIndex; node: ts.ClassLikeDeclaration } | undefined {
    const binding = bindingOf(identifier);
    if (binding?.kind === "class") return { index, node: binding.node };
    if (binding?.kind !== "import" || depth > 4) return undefined;
    const imported = this.importTarget(index, identifier.text);
    if (imported === undefined || imported.name === "*") return undefined;
    const found = this.exportedValue(imported.target, imported.name);
    if (found !== undefined && ts.isClassLike(found.value))
      return { index: found.index, node: found.value };
    if (found !== undefined && ts.isIdentifier(found.value))
      return this.classAt(found.index, found.value, depth + 1);
    return undefined;
  }

  /** The class an expression names: `C` (declared or imported) or `W.C` for `import * as W`. */
  classOfExpression(
    index: ModuleIndex,
    expression: ts.Expression
  ): { index: ModuleIndex; node: ts.ClassLikeDeclaration } | undefined {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) return this.classAt(index, expression);
    if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression))
      return undefined;
    if (bindingOf(expression.expression)?.kind !== "import") return undefined;
    const imported = this.importTarget(index, expression.expression.text);
    if (imported?.name !== "*") return undefined;
    const found = this.exportedValue(imported.target, expression.name.text);
    if (found !== undefined && ts.isClassLike(found.value))
      return { index: found.index, node: found.value };
    if (found !== undefined && ts.isIdentifier(found.value))
      return this.classAt(found.index, found.value);
    return undefined;
  }

  /**
   * The method a `receiver.name(...)` call reaches, by its node and module: `this.name` in a class
   * or object; `new C().name` and `c.name` for `const c = new C()` (C declared or imported); the
   * static `C.name`; `api.name` for an object literal held in `api` (here or imported); `W.name`
   * for a namespace import. Undefined when the receiver cannot be pinned down.
   */
  memberAt(
    index: ModuleIndex,
    call: ts.CallExpression
  ): { index: ModuleIndex; fn: FunctionNode } | undefined {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const name = callee.name.text;
    const receiver = unwrapExpression(callee.expression);
    const ofClass = (
      found: { index: ModuleIndex; node: ts.ClassLikeDeclaration } | undefined,
      isStatic: boolean
    ) => {
      const fn = found === undefined ? undefined : memberFunction(found.node, name, 0, isStatic);
      return fn === undefined ? undefined : { index: found!.index, fn };
    };
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
      const container = thisContainer(call);
      const fn = container === undefined ? undefined : memberFunction(container, name);
      return fn === undefined ? undefined : { index, fn };
    }
    if (ts.isNewExpression(receiver))
      return ofClass(this.classOfExpression(index, receiver.expression), false);
    // `W.C.send` (a static method of a namespace-imported class) and `W.api.send`.
    if (ts.isPropertyAccessExpression(receiver)) {
      const namespaced = this.classOfExpression(index, receiver);
      if (namespaced !== undefined) return ofClass(namespaced, true);
      return this.memberOfValue(index, receiver, name, ofClass);
    }
    if (!ts.isIdentifier(receiver)) return undefined;
    const binding = bindingOf(receiver);
    if (binding?.kind === "class") return ofClass({ index, node: binding.node }, true);
    if (binding?.kind === "import") {
      const imported = this.importTarget(index, receiver.text);
      if (imported?.name === "*")
        return this.functionOfExport(this.exportedValue(imported.target, name));
      const importedClass = this.classAt(index, receiver);
      if (importedClass !== undefined) return ofClass(importedClass, true);
    }
    return this.memberOfValue(index, receiver, name, ofClass);
  }

  /**
   * The method `name` of the value a receiver holds (`api`, `W.api`, possibly in an imported
   * module): an object literal's member, or an instance's (`new C()`) method.
   */
  private memberOfValue(
    index: ModuleIndex,
    receiver: ts.Identifier | ts.PropertyAccessExpression,
    name: string,
    ofClass: (
      found: { index: ModuleIndex; node: ts.ClassLikeDeclaration } | undefined,
      isStatic: boolean
    ) => { index: ModuleIndex; fn: FunctionNode } | undefined
  ): { index: ModuleIndex; fn: FunctionNode } | undefined {
    const found = this.valueOf(index, receiver.getText(), receiver.getStart());
    const value = found?.value === undefined ? undefined : unwrapExpression(found.value);
    if (found === undefined || value === undefined) return undefined;
    if (ts.isObjectLiteralExpression(value)) {
      const fn = memberFunction(value, name);
      return fn === undefined ? undefined : { index: found.index, fn };
    }
    if (ts.isNewExpression(value))
      return ofClass(this.classOfExpression(found.index, value.expression), false);
    return undefined;
  }

  /**
   * The value of a dotted name (`OCR_PATH`, `paths.documents.ocr`, `P.OCR` for a namespace
   * import) as seen at `position`: the expression and the module it lives in.
   */
  private valueOf(
    index: ModuleIndex,
    dotted: string,
    position: number
  ):
    | {
        index: ModuleIndex;
        value: ts.Expression | undefined;
        parameter: boolean;
        type?: ts.TypeNode | undefined;
      }
    | undefined {
    const [head, ...rest] = dotted.split(".");
    let owner = index;
    let value: ts.Expression | undefined;
    let parameter = false;
    let type: ts.TypeNode | undefined;
    // The declaration in scope at `position`: the innermost scope that contains it, then the
    // latest declaration before it (or the first, for a use above a hoisted declaration).
    const visible = (index.values.get(head!) ?? []).filter(
      (entry) => entry.scope.pos <= position && position < entry.scope.end
    );
    const innermost = Math.max(...visible.map((entry) => entry.scope.pos));
    const declarations = visible.filter((entry) => entry.scope.pos === innermost);
    const local =
      declarations.filter((entry) => entry.position < position).at(-1) ?? declarations[0];
    if (local !== undefined) {
      value = local.value;
      parameter = local.parameter;
      type = local.type;
    } else {
      const imported = this.importTarget(index, head!);
      if (imported === undefined) return undefined;
      const member = imported.name === "*" ? rest.shift() : imported.name;
      if (member === undefined) return undefined;
      const found = this.exportedValue(imported.target, member);
      owner = found?.index ?? imported.target;
      value =
        found !== undefined && !ts.isFunctionLike(found.value)
          ? (found.value as ts.Expression)
          : undefined;
      if (value === undefined) return { index: owner, value: undefined, parameter: false };
    }
    for (const property of rest) {
      while (
        value !== undefined &&
        (ts.isAsExpression(value) ||
          ts.isSatisfiesExpression(value) ||
          ts.isParenthesizedExpression(value))
      )
        value = value.expression;
      if (value === undefined || !ts.isObjectLiteralExpression(value))
        return { index: owner, value: undefined, parameter };
      const member = value.properties.find((candidate) => candidate.name?.getText() === property);
      value =
        member !== undefined && ts.isPropertyAssignment(member) ? member.initializer : undefined;
    }
    return { index: owner, value, parameter, type };
  }

  /** Builder calls being resolved: their parameters bound to the call's arguments. */
  private frames: {
    fn: ts.Node;
    params: Map<string, { index: ModuleIndex; expression: ts.Expression | undefined }>;
  }[] = [];

  /** Resolves a builder's returns with its parameters bound to the call's arguments. */
  private callBuilder(
    builderIndex: ModuleIndex,
    fn: ts.SignatureDeclaration & { body?: ts.Node | undefined },
    callerIndex: ModuleIndex,
    args: readonly ts.Expression[],
    depth: number
  ): Resolved[] {
    const returned = returnedExpressions(fn);
    if (returned.length === 0) return [{ kind: "dynamic" }];
    const params = new Map<string, { index: ModuleIndex; expression: ts.Expression | undefined }>();
    fn.parameters.forEach((parameter, position) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const argument = args[position];
      params.set(
        parameter.name.text,
        argument !== undefined
          ? { index: callerIndex, expression: argument }
          : { index: builderIndex, expression: parameter.initializer }
      );
    });
    this.frames.push({ fn, params });
    try {
      return returned.flatMap((value) => this.resolve(builderIndex, value, depth + 1));
    } finally {
      this.frames.pop();
    }
  }

  /** A builder function a call names: `ocrPath(id)`, `this.path(id, "/x")`, `endpoints.ocr(id)`. */
  builderOf(index: ModuleIndex, call: ts.CallExpression) {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      if (apiHelpers.has(callee.text)) return undefined;
      // The function this name means at the call: declared in scope, or imported.
      return this.functionAt(index, callee);
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    // A method of a class, object or namespace the receiver pins down (see `memberAt`).
    const member = this.memberAt(index, call);
    if (member !== undefined) return member;
    if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) return undefined;
    // A function held deeper in an endpoint object (`endpoints.docs.ocr(id)`).
    const held = this.valueOf(index, callee.getText(), call.getStart());
    const fn = held?.value === undefined ? undefined : functionValue(held.value);
    return held !== undefined && fn !== undefined ? { index: held.index, fn } : undefined;
  }

  /** The innermost frame binding this identifier, if it names a parameter of a bound function. */
  private boundIdentifier(identifier: ts.Identifier) {
    for (let position = this.frames.length - 1; position >= 0; position--) {
      const frame = this.frames[position]!;
      if (
        frame.fn.getSourceFile() !== identifier.getSourceFile() ||
        identifier.getStart() < frame.fn.getStart() ||
        identifier.getEnd() > frame.fn.getEnd()
      )
        continue;
      const binding = frame.params.get(identifier.text);
      // Not a parameter of this function: a closure over an enclosing bound function's one.
      if (binding !== undefined) return { position, binding };
    }
    return undefined;
  }

  /** Resolves a bound argument in its caller's context (outer frames only). */
  private resolveBinding(
    bound: {
      position: number;
      binding: { index: ModuleIndex; expression: ts.Expression | undefined };
    },
    depth: number
  ): Resolved[] {
    if (bound.binding.expression === undefined) return [{ kind: "dynamic" }];
    const saved = this.frames;
    this.frames = saved.slice(0, bound.position);
    try {
      return this.resolve(bound.binding.index, bound.binding.expression, depth + 1);
    } finally {
      this.frames = saved;
    }
  }

  /** `{ base, doFetch }` passed for `input`: the expression given for `input.base`. */
  private memberOfBinding(
    bound: {
      position: number;
      binding: { index: ModuleIndex; expression: ts.Expression | undefined };
    },
    name: string
  ): { index: ModuleIndex; expression: ts.Expression | undefined } | undefined {
    let value = bound.binding.expression;
    while (value !== undefined && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)))
      value = value.expression;
    if (value === undefined || !ts.isObjectLiteralExpression(value)) return undefined;
    const member = value.properties.find((property) => property.name?.getText() === name);
    if (member !== undefined && ts.isPropertyAssignment(member))
      return { index: bound.binding.index, expression: member.initializer };
    if (member !== undefined && ts.isShorthandPropertyAssignment(member))
      return { index: bound.binding.index, expression: member.name };
    return undefined;
  }

  /** Runs `work` with `fn`'s parameters bound to `args` (missing ones to their defaults). */
  withFrame<T>(
    fn: ts.SignatureDeclaration & { body?: ts.Node | undefined },
    callerIndex: ModuleIndex,
    fnIndex: ModuleIndex,
    args: readonly ts.Expression[] | undefined,
    work: () => T
  ): T {
    const params = new Map<string, { index: ModuleIndex; expression: ts.Expression | undefined }>();
    fn.parameters.forEach((parameter, position) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const argument = args?.[position];
      params.set(
        parameter.name.text,
        argument !== undefined
          ? { index: callerIndex, expression: argument }
          : { index: fnIndex, expression: parameter.initializer }
      );
    });
    this.frames.push({ fn, params });
    try {
      return work();
    } finally {
      this.frames.pop();
    }
  }

  /** A wrapper's request path at one of its call sites, with its parameters bound. */
  resolveWrapperCall(
    wrapper: Wrapper,
    callerIndex: ModuleIndex,
    args: readonly ts.Expression[] | undefined
  ): Resolved[] {
    return this.withFrame(wrapper.fn, callerIndex, wrapper.index, args, () => {
      const nested = wrapper.nested;
      if (nested === undefined) return this.resolve(wrapper.index, wrapper.argument);
      return this.withFrame(
        nested.inner.fn,
        wrapper.index,
        nested.inner.index,
        nested.call.arguments,
        () => this.resolve(nested.inner.index, nested.inner.argument)
      );
    });
  }

  /** `"import" | "sync"`, or a local type alias of one: its literal words. */
  private literalUnion(
    index: ModuleIndex,
    type: ts.TypeNode | undefined,
    depth = 0
  ): string[] | undefined {
    if (type === undefined || depth > 3) return undefined;
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text];
    if (ts.isUnionTypeNode(type)) {
      const words = type.types.map((member) => this.literalUnion(index, member, depth + 1));
      return words.every((list) => list !== undefined) ? (words.flat() as string[]) : undefined;
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const name = type.typeName.text;
      const alias = index.source.statements.find(
        (statement): statement is ts.TypeAliasDeclaration =>
          ts.isTypeAliasDeclaration(statement) && statement.name.text === name
      );
      return alias === undefined ? undefined : this.literalUnion(index, alias.type, depth + 1);
    }
    return undefined;
  }

  /** The literal words a piece after the start of a path can be, when it is a finite set. */
  private literalWords(index: ModuleIndex, expression: ts.Expression, depth: number) {
    if (ts.isIdentifier(expression) && this.boundIdentifier(expression) === undefined) {
      const declared = this.valueOf(index, expression.text, expression.getStart());
      if (declared !== undefined && declared.value === undefined) {
        const words = this.literalUnion(declared.index, declared.type);
        if (words !== undefined) return words;
      }
    }
    const results = this.resolve(index, expression, depth + 1);
    if (
      results.length > 0 &&
      results.every(
        (result) => result.kind === "path" && !result.text.includes("\u0000") && !result.open
      )
    )
      return results.map((result) => (result as { text: string }).text);
    return undefined;
  }

  resolve(index: ModuleIndex, expression: ts.Expression, depth = 0): Resolved[] {
    if (depth > 12) return [{ kind: "dynamic" }];
    // A parameter of a builder or wrapper being resolved is the argument its call passed.
    if (ts.isIdentifier(expression)) {
      const bound = this.boundIdentifier(expression);
      if (bound !== undefined) return this.resolveBinding(bound, depth);
    }
    // `input.base` where `input` is a bound parameter: the property of the argument passed.
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const bound = this.boundIdentifier(expression.expression);
      if (bound !== undefined) {
        const member = this.memberOfBinding(bound, expression.name.text);
        if (member === undefined) return [{ kind: "dynamic" }];
        return this.resolveBinding({ ...bound, binding: member }, depth);
      }
    }
    // `NET.connection(id).respond`: a builder that returns an object, then a property of it.
    if (ts.isPropertyAccessExpression(expression) && ts.isCallExpression(expression.expression)) {
      const call = expression.expression;
      const builder = this.builderOf(index, call);
      if (builder === undefined) return [{ kind: "dynamic" }];
      return this.withFrame(builder.fn, index, builder.index, call.arguments, () =>
        returnedExpressions(builder.fn).flatMap((returned) => {
          let value: ts.Expression = returned;
          while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value))
            value = value.expression;
          if (!ts.isObjectLiteralExpression(value)) return [{ kind: "dynamic" } as Resolved];
          const member = value.properties.find(
            (property) => property.name?.getText() === expression.name.text
          );
          if (member !== undefined && ts.isPropertyAssignment(member))
            return this.resolve(builder.index, member.initializer, depth + 1);
          if (member !== undefined && ts.isShorthandPropertyAssignment(member))
            return this.resolve(builder.index, member.name, depth + 1);
          return [{ kind: "dynamic" } as Resolved];
        })
      );
    }

    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    )
      return this.resolve(index, expression.expression, depth + 1);
    if (ts.isConditionalExpression(expression))
      return [
        ...this.resolve(index, expression.whenTrue, depth + 1),
        ...this.resolve(index, expression.whenFalse, depth + 1)
      ];
    // `options.apiBaseUrl ?? readApiBaseUrl()`: either side can be the value.
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      return [
        ...this.resolve(index, expression.left, depth + 1),
        ...this.resolve(index, expression.right, depth + 1)
      ];
    const parts = pieces(expression);
    if (parts !== null) return this.resolveParts(index, parts, depth);
    // `PATHS["ocr"]` is `PATHS.ocr`; a computed key (`PATHS[k]`) is dynamic.
    if (ts.isElementAccessExpression(expression)) {
      const key = expression.argumentExpression;
      const owner = expression.expression;
      if (
        (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) &&
        /^[\w$.]+$/u.test(owner.getText())
      ) {
        const dotted = `${owner.getText()}.${key.text}`;
        const found = this.valueOf(index, dotted, expression.getStart());
        if (found === undefined) return [{ kind: "dynamic" }];
        if (found.value === undefined)
          return found.parameter ? [{ kind: "dynamic" }] : [{ kind: "unresolved", name: dotted }];
        return this.resolve(found.index, found.value, depth + 1);
      }
      return [{ kind: "dynamic" }];
    }
    // String(x), encodeURI(x), new URL(x) and new Request(x) are x.
    if (
      (ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        ["String", "encodeURI"].includes(expression.expression.text)) ||
      (ts.isNewExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        (expression.expression.text === "Request" ||
          (expression.expression.text === "URL" && (expression.arguments?.length ?? 0) === 1)))
    ) {
      const inner = expression.arguments?.[0];
      return inner === undefined ? [{ kind: "dynamic" }] : this.resolve(index, inner, depth + 1);
    }
    // `url.replace(/\/mcp.*$/u, "/v1/shop-system")`: the result ends with the replacement path,
    // on a base this check cannot see.
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ["replace", "replaceAll"].includes(expression.expression.name.text) &&
      expression.arguments.length === 2 &&
      ts.isRegularExpressionLiteral(expression.arguments[0]!) &&
      /\$\/[a-z]*$/u.test(expression.arguments[0].text) &&
      ts.isStringLiteral(expression.arguments[1]!) &&
      expression.arguments[1].text.startsWith("/")
    )
      return [{ kind: "suffix", text: expression.arguments[1].text }];
    // `base.replace(/\/+$/u, "")`, `base.trim()`: a base with its ends tidied is still that base.
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ["replace", "replaceAll", "trim", "trimEnd", "trimStart", "toString"].includes(
        expression.expression.name.text
      )
    )
      return this.resolve(index, expression.expression.expression, depth + 1);
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
      const text = expression.getText();
      // The API base comes from VITE_API_BASE_URL / VITE_API_URL (lib/api.ts); any other env
      // value is another origin.
      if (/^import\.meta\.env\.VITE_API_(?:BASE_)?URL$/u.test(text)) return [{ kind: "apiBase" }];
      if (/^import\.meta\.env\./u.test(text)) return [{ kind: "external" }];
      // A declared value wins over what the name suggests: `const apiBaseUrl = x.replace(...)`
      // is whatever that expression is.
      const found = this.valueOf(index, text, expression.getStart());
      if (found === undefined || (found.value === undefined && found.parameter)) {
        if (apiBasePattern.test(text)) return [{ kind: "apiBase" }];
        if (externalBasePattern.test(text)) return [{ kind: "external" }];
      }
      if (found === undefined) return [{ kind: "dynamic" }];
      if (found.value === undefined)
        return found.parameter ? [{ kind: "dynamic" }] : [{ kind: "unresolved", name: text }];
      return this.resolve(found.index, found.value, depth + 1);
    }
    if (ts.isCallExpression(expression)) {
      const name = calleeName(expression);
      if (apiBasePattern.test(name)) return [{ kind: "apiBase" }];
      // `ocrPath(id)`, `this.path(id, "/x")`, `endpoints.ocr(id)`: a builder, with its
      // parameters bound to this call's arguments.
      const builder = this.builderOf(index, expression);
      if (builder !== undefined)
        return this.callBuilder(builder.index, builder.fn, index, expression.arguments, depth);
    }
    return [{ kind: "dynamic" }];
  }

  private resolveParts(index: ModuleIndex, parts: Piece[], depth: number): Resolved[] {
    let open = false;
    const withOpen = (results: Resolved[]) =>
      open
        ? results.map((result) => ("text" in result ? { ...result, open: true } : result))
        : results;
    return withOpen(this.resolvePartsClosed(index, parts, depth, (value) => (open = value)));
  }

  private resolvePartsClosed(
    index: ModuleIndex,
    parts: Piece[],
    depth: number,
    setOpen: (value: boolean) => void
  ): Resolved[] {
    let open = false;
    // `${path}${query}`: an expression glued to the end of a word is a query string, not a segment.
    while (
      parts.length > 1 &&
      "text" in parts.at(-1)! &&
      (parts.at(-1) as { text: string }).text === ""
    )
      parts = parts.slice(0, -1);
    // A trailing expression glued to a word or to another expression (`/products${q}`,
    // `${path}${query}`, `?${search}`) is a query or suffix, not a path segment.
    const last = parts.at(-1);
    const previous = parts.at(-2);
    if (
      parts.length > 1 &&
      last !== undefined &&
      "expression" in last &&
      previous !== undefined &&
      ("expression" in previous || !previous.text.endsWith("/"))
    ) {
      // ...unless it is itself a path (`${baseUrl}${refreshPath}`): then use its value.
      const glued = this.resolve(index, last.expression, depth + 1);
      const gluedPaths = glued.flatMap((result) =>
        result.kind === "path" && result.text.startsWith("/") ? [result.text] : []
      );
      if (gluedPaths.length === 1 && glued.length === 1)
        parts = [...parts.slice(0, -1), { text: gluedPaths[0]! }];
      else {
        parts = parts.slice(0, -1);
        // A query string is common here, but so is a sub-path (`/businesses/${id}${tail}`).
        const tidied = parts.at(-1);
        open = !(tidied !== undefined && "text" in tidied && tidied.text.includes("?"));
      }
    }
    setOpen(open);
    // Later pieces that are a finite set of literal words (`${kind === "csv" ? "supplier-csv" :
    // "product-catalogue"}`, a constant, a `"import" | "sync"` parameter) expand into every
    // combination, up to 32; any other piece is a dynamic segment.
    const tails = (from: number): string[] => {
      let combos = [""];
      for (const part of parts.slice(from)) {
        if ("text" in part) {
          combos = combos.map((combo) => combo + part.text);
          continue;
        }
        const words = this.literalWords(index, part.expression, depth);
        combos =
          words !== undefined && combos.length * words.length <= 32
            ? combos.flatMap((combo) => words.map((word) => combo + word))
            : combos.map((combo) => combo + "\u0000");
      }
      return combos;
    };
    const first = parts[0];
    if (first === undefined) return [{ kind: "path", text: "" }];
    if ("text" in first)
      return tails(0).map((text) =>
        /^https?:\/\//u.test(text) ? { kind: "external" } : { kind: "path", text }
      );
    // The first piece is an expression: the base the rest is appended to.
    const rests = tails(1);
    return this.resolve(index, first.expression, depth + 1).flatMap((base): Resolved[] =>
      rests.map((rest): Resolved => {
        switch (base.kind) {
          case "path":
            return { kind: "path", text: base.text + rest };
          case "api":
            return { kind: "api", text: base.text + rest };
          case "apiBase":
            return { kind: "api", text: rest };
          case "suffix":
            return { kind: "suffix", text: base.text + rest };
          case "external":
            return { kind: "external" };
          case "unresolved":
            return base;
          case "dynamic":
            return { kind: "suffix", text: rest };
        }
      })
    );
  }

  /**
   * One level: a function that passes a parameter to a request (`apiFetch(path)`,
   * `` apiFetch(`${path}?${search}`) ``, `` fetcher(`${path}/x`) ``) is itself a request site.
   */
  private findWrappers(index: ModuleIndex) {
    this.findWrappersIn(index, [...index.functions, ...index.methods]);
    this.findNestedWrapperSites(index);
  }

  /**
   * A wrapper declared inside another function, whose path uses that function's parameters
   * (`const post = (path) => input.doFetch(`${input.base}/x/${path}`)` inside a function of
   * `input`): each call to it is a request site of the enclosing function too, so the enclosing
   * function's call sites bind `input` and the inner call binds `path`.
   */
  private findNestedWrapperSites(index: ModuleIndex) {
    for (const outer of [...index.functions, ...index.methods]) {
      const outerParameters = new Set(
        outer.parameters.flatMap((parameter) =>
          ts.isIdentifier(parameter.name) ? [parameter.name.text] : []
        )
      );
      if (outerParameters.size === 0 || outer.body === undefined) continue;
      const usesOuter = (node: ts.Node): boolean =>
        (ts.isIdentifier(node) && outerParameters.has(node.text)) ||
        ts.forEachChild(node, (child) => usesOuter(child) || undefined) === true;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          // The function this name means here (not another one of the same name in the file).
          const inner = functionInScope(node.expression);
          const innerWrapper = inner === undefined ? undefined : index.wrapperByNode.get(inner);
          if (
            inner !== undefined &&
            innerWrapper !== undefined &&
            inner.getStart() > outer.getStart() &&
            inner.getEnd() < outer.getEnd()
          )
            for (const site of [innerWrapper, ...innerWrapper.extra])
              if (usesOuter(site.argument)) {
                const wrapper: Wrapper = {
                  ...site,
                  fn: outer,
                  index,
                  methodParameter: undefined,
                  extra: [],
                  nested: { inner: site, call: node }
                };
                const existing = index.wrapperByNode.get(outer);
                if (existing !== undefined) existing.extra.push(wrapper);
                else index.wrapperByNode.set(outer, wrapper);
              }
        }
        ts.forEachChild(node, visit);
      };
      visit(outer.body);
    }
  }

  /**
   * One level: a function whose request path depends on one of its parameters (in any position,
   * directly or through a local constant) is itself a request site; its call sites are resolved
   * with the parameters bound (`resolveWrapperCall`).
   */
  private findWrappersIn(index: ModuleIndex, functions: Iterable<FunctionNode>) {
    for (const fn of functions) {
      const parameters = new Set(
        fn.parameters.flatMap((parameter) =>
          ts.isIdentifier(parameter.name) ? [parameter.name.text] : []
        )
      );
      if (parameters.size === 0) continue;
      const usesParameter = (node: ts.Node, depth = 0): boolean => {
        if (ts.isIdentifier(node)) {
          if (parameters.has(node.text)) return true;
          // A local constant built from a parameter (`const url = `${base}/x``).
          if (depth < 2) {
            const value = declaredInScope(node);
            if (
              value !== undefined &&
              value.getStart() > fn.getStart() &&
              value.getEnd() < fn.getEnd()
            )
              return usesParameter(value, depth + 1);
          }
          return false;
        }
        return ts.forEachChild(node, (child) => usesParameter(child, depth) || undefined) === true;
      };
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callee = calleeName(node);
          // The same identity call sites get: an alias is its import, a third-party import is no
          // helper or fetch, a project function is never fetch by its name.
          const identity = ts.isCallExpression(node)
            ? this.calleeIdentity(index, node.expression)
            : { name: "", project: false };
          const effective = identity.name || callee;
          const argument = node.arguments?.[0];
          const request =
            apiHelpers.has(effective) ||
            (!identity.project && isRawCallee(effective)) ||
            (ts.isNewExpression(node) && ["Request", "EventSource", "WebSocket"].includes(callee));
          if (request && argument !== undefined && usesParameter(argument)) {
            const options = node.arguments?.[1];
            let methodParameter: number | undefined;
            if (options !== undefined && ts.isObjectLiteralExpression(options))
              for (const property of options.properties) {
                if (property.name?.getText() !== "method") continue;
                const passed = ts.isShorthandPropertyAssignment(property)
                  ? property.name.text
                  : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
                    ? property.initializer.text
                    : undefined;
                if (passed !== undefined && parameters.has(passed))
                  methodParameter = fn.parameters.findIndex(
                    (parameter) => parameter.name.getText() === passed
                  );
              }
            const wrapper: Wrapper = {
              fn,
              index,
              argument,
              callee: ts.isNewExpression(node) ? "fetch" : effective,
              method:
                ts.isNewExpression(node) && callee !== "Request"
                  ? "GET"
                  : // The stated method, else the helper's own (`request = postJson` is POST).
                    (this.methodAt(index, argument) ??
                    (Object.hasOwn(methodByHelper, effective)
                      ? methodByHelper[effective]
                      : undefined)),
              methodParameter,
              extra: []
            };
            // A function with several request sites (a stream and a post) is all of them.
            const existing = index.wrapperByNode.get(fn);
            if (existing !== undefined) existing.extra.push(wrapper);
            else index.wrapperByNode.set(fn, wrapper);
          }
        }
        ts.forEachChild(node, visit);
      };
      if (fn.body) visit(fn.body);
    }
  }

  /**
   * A method wrapper, when the receiver provably has that method: `this` inside a class, an object
   * literal that declares it (`api.post`), or an instance of a class that declares it.
   */
  methodWrapperFor(index: ModuleIndex, call: ts.CallExpression) {
    const member = this.memberAt(index, call);
    return member === undefined ? undefined : member.index.wrapperByNode.get(member.fn);
  }

  /**
   * The wrapper a called name means at the call: the function declared in scope (its own
   * wrapper, or none), else an imported one. A same-named function elsewhere in the file is not
   * it.
   */
  scopedWrapper(index: ModuleIndex, callee: ts.Identifier) {
    const found = this.functionAt(index, callee);
    return found === undefined ? undefined : found.index.wrapperByNode.get(found.fn);
  }
}

/**
 * The HTTP method a request call states, when knowable. `nameOf` says what each enclosing call is
 * (the resolver's identity: an alias is its import, `request = apiFetch` is apiFetch, a
 * third-party import is nothing); without it, the callee's own name.
 */
function statedMethod(
  node: ts.Node,
  nameOf: (call: ts.CallExpression | ts.NewExpression) => string = calleeName
): string | undefined {
  for (
    let current = node.parent, depth = 0;
    current && depth < 6;
    current = current.parent, depth++
  ) {
    const isRequestObject = ts.isNewExpression(current) && calleeName(current) === "Request";
    if (!ts.isCallExpression(current) && !isRequestObject) continue;
    const call = current as ts.CallExpression | ts.NewExpression;
    const name = isRequestObject ? "Request" : nameOf(call);
    if (Object.hasOwn(methodByHelper, name) && methodByHelper[name] !== undefined)
      return methodByHelper[name];
    if (name === "sendBeacon") return "POST";
    if (!isRequestObject && !optionCallers.has(name) && !isRawCallee(name)) return undefined;
    let options = call.arguments?.[1];
    if (options === undefined) return "GET";
    if (ts.isIdentifier(options)) options = objectDeclaration(options) ?? options;
    if (!ts.isObjectLiteralExpression(options)) return undefined;
    for (const property of options.properties) {
      if (property.name?.getText() !== "method") continue;
      if (ts.isPropertyAssignment(property)) {
        let value: ts.Expression = property.initializer;
        while (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))
          value = value.expression;
        if (ts.isStringLiteral(value)) return value.text.toUpperCase();
        // `method: METHOD.remove` with `const METHOD = { remove: "DELETE" }` in scope.
        if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
          const table = objectDeclaration(value.expression);
          const entry = table?.properties.find(
            (candidate) =>
              candidate.name?.getText() === (value as ts.PropertyAccessExpression).name.text
          );
          if (
            entry !== undefined &&
            ts.isPropertyAssignment(entry) &&
            ts.isStringLiteral(entry.initializer)
          )
            return entry.initializer.text.toUpperCase();
        }
      }
      if (ts.isShorthandPropertyAssignment(property))
        return stringConstant(property.name)?.toUpperCase();
      return undefined;
    }
    if (options.properties.some((property) => ts.isSpreadAssignment(property))) return undefined;
    return "GET";
  }
  return undefined;
}

/**
 * The value a name has where it is used, following real scopes: the nearest enclosing block's
 * earlier declaration, outward to the file. A parameter of an enclosing function shadows outer
 * declarations, and has no value here.
 */
function declaredInScope(identifier: ts.Identifier): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (shadowedAt(scope, identifier.text)) return undefined;
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      let found: ts.Expression | undefined;
      for (const statement of scope.statements) {
        if (statement.getStart() >= identifier.getStart() || !ts.isVariableStatement(statement))
          continue;
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text)
            found = declaration.initializer;
      }
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Where a variable or parameter is visible: a parameter in its function; a variable in its
 * nearest block, file, `case` block, loop header or `catch` clause.
 */
function declarationScope(declaration: ts.Node): ts.Node {
  if (ts.isParameter(declaration)) return declaration.parent;
  for (let scope = declaration.parent; scope; scope = scope.parent)
    if (
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isModuleBlock(scope) ||
      ts.isCaseBlock(scope) ||
      ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope) ||
      ts.isCatchClause(scope)
    )
      return scope;
  return declaration.getSourceFile();
}

/** Every name a declaration binds: `x`, `{ a, b: { c } }`, `[d, ...e]`. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundNames(element.name)
  );
}

/**
 * A scope node that binds `name` through something other than its statements: a parameter
 * (destructured too), a `for`/`for…of`/`for…in` declaration or a `catch` variable.
 */
function shadowedAt(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(scope))
    return scope.parameters.some((parameter) => boundNames(parameter.name).includes(name));
  if (ts.isCatchClause(scope))
    return (
      scope.variableDeclaration !== undefined &&
      boundNames(scope.variableDeclaration.name).includes(name)
    );
  if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  )
    return scope.initializer.declarations.some((declaration) =>
      boundNames(declaration.name).includes(name)
    );
  return false;
}

/** An expression without the parentheses, `as`, `satisfies` and `!` around it. */
function unwrapExpression(value: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  )
    value = value.expression;
  return value;
}

/** The function a value is: an arrow, a function expression, or a useCallback/useMemo callback. */
function functionValue(value: ts.Expression | undefined): FunctionNode | undefined {
  while (
    value !== undefined &&
    (ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isSatisfiesExpression(value))
  )
    value = value.expression;
  if (value === undefined) return undefined;
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  const callback = ts.isCallExpression(value) ? value.arguments[0] : undefined;
  if (
    ts.isCallExpression(value) &&
    ["useCallback", "useMemo"].includes(calleeName(value)) &&
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
  )
    return callback;
  return undefined;
}

type Binding =
  | { kind: "function"; fn: FunctionNode }
  | { kind: "class"; node: ts.ClassLikeDeclaration }
  | { kind: "import" }
  | { kind: "other" };

/**
 * What a name refers to where it is written, following JavaScript's scopes from the innermost
 * outward: a function (declaration, or a `const` holding an arrow, function or useCallback
 * callback), a class, an import, or something else (a parameter, destructured or not, a loop or
 * `catch` variable, any other declaration), which hides every outer declaration of the name.
 * Undefined when the file does not declare the name (a global).
 */
function bindingOf(identifier: ts.Identifier): Binding | undefined {
  const name = identifier.text;
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (shadowedAt(scope, name)) return { kind: "other" };
    // A named function expression sees its own name.
    if (ts.isFunctionExpression(scope) && scope.name?.text === name)
      return { kind: "function", fn: scope };
    const statements =
      ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : ts.isCaseBlock(scope)
          ? scope.clauses.flatMap((clause) => [...clause.statements])
          : undefined;
    if (statements === undefined) continue;
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
        // Overload signatures have no body; the implementation follows them.
        if (statement.body !== undefined) return { kind: "function", fn: statement };
        continue;
      }
      if (ts.isClassDeclaration(statement) && statement.name?.text === name)
        return { kind: "class", node: statement };
      if (ts.isEnumDeclaration(statement) && statement.name.text === name) return { kind: "other" };
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        if (
          clause?.name?.text === name ||
          (bindings !== undefined &&
            (ts.isNamespaceImport(bindings)
              ? bindings.name.text === name
              : bindings.elements.some((element) => element.name.text === name)))
        )
          return { kind: "import" };
        continue;
      }
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!boundNames(declaration.name).includes(name)) continue;
        if (!ts.isIdentifier(declaration.name)) return { kind: "other" };
        const value = declaration.initializer;
        const fn = functionValue(value);
        if (fn !== undefined) return { kind: "function", fn };
        if (value !== undefined && ts.isClassExpression(value))
          return { kind: "class", node: value };
        return { kind: "other" };
      }
    }
  }
  return undefined;
}

/** The function a called name refers to where it is called (see `bindingOf`). */
function functionInScope(identifier: ts.Identifier): FunctionNode | undefined {
  const binding = bindingOf(identifier);
  return binding?.kind === "function" ? binding.fn : undefined;
}

/** A property or member name as written: `send`, `"send"`, `1`. */
function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

/**
 * The method `name` of this class or object literal, by its node: a method, or a property or
 * class field holding a function. A class without it looks in the class it extends, when that
 * class is declared in the file.
 */
function memberFunction(
  container: ts.ClassLikeDeclaration | ts.ObjectLiteralExpression,
  name: string,
  depth = 0,
  isStatic?: boolean
): FunctionNode | undefined {
  if (ts.isObjectLiteralExpression(container)) {
    // The last property of that name wins, as in JavaScript.
    for (const property of [...container.properties].reverse()) {
      if (memberName(property.name) !== name) continue;
      if (ts.isMethodDeclaration(property))
        return property.body === undefined ? undefined : property;
      if (ts.isPropertyAssignment(property)) return functionValue(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return functionInScope(property.name);
      return undefined;
    }
    return undefined;
  }
  for (const member of container.members) {
    if (memberName(member.name) !== name) continue;
    // `C.send` is the static member, `new C().send` an instance one (`this` matches either).
    const memberIsStatic =
      (ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
    if (isStatic !== undefined && memberIsStatic !== isStatic) continue;
    if (ts.isMethodDeclaration(member) && member.body !== undefined) return member;
    if (ts.isPropertyDeclaration(member)) return functionValue(member.initializer);
  }
  const base = container.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
  )?.types[0]?.expression;
  if (base !== undefined && ts.isIdentifier(base) && depth < 4) {
    const binding = bindingOf(base);
    if (binding?.kind === "class") return memberFunction(binding.node, name, depth + 1, isStatic);
  }
  return undefined;
}

/**
 * The class or object literal `this` means at a node: the class of the method, accessor,
 * constructor or field it is in (arrows keep the outer `this`), or the object literal of a
 * method or function-valued property. Undefined inside a plain function.
 */
function thisContainer(
  node: ts.Node
): ts.ClassLikeDeclaration | ts.ObjectLiteralExpression | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue;
    if (ts.isClassLike(current)) return current;
    if (ts.isClassStaticBlockDeclaration(current)) return current.parent;
    if (!ts.isFunctionLike(current)) continue;
    const holder = current.parent;
    if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    )
      return ts.isClassLike(holder) || ts.isObjectLiteralExpression(holder) ? holder : undefined;
    if (
      ts.isFunctionExpression(current) &&
      ts.isPropertyAssignment(holder) &&
      ts.isObjectLiteralExpression(holder.parent)
    )
      return holder.parent;
    return undefined;
  }
  return undefined;
}

/** `const method = "DELETE"` in scope, if that is what the name is. */
function stringConstant(identifier: ts.Identifier): string | undefined {
  const value = declaredInScope(identifier);
  return value !== undefined && ts.isStringLiteral(value) ? value.text : undefined;
}

/** `const init = { method: "PUT" }` in scope, if that is what the name is. */
function objectDeclaration(identifier: ts.Identifier): ts.ObjectLiteralExpression | undefined {
  let value = declaredInScope(identifier);
  while (value !== undefined && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)))
    value = value.expression;
  return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined;
}

function clean(text: string) {
  return (
    text
      .split("?")[0]!
      .replace(/\/{2,}/gu, "/")
      .replace(/\/+$/u, "") || "/"
  );
}

export function extractWebCalls(files: string[], routes: RouteEntry[]): ClientCall[] {
  const prefixes = new Set(routes.map((route) => segments(route.path)[0]).filter(Boolean));
  const sources = files.map((file) =>
    ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  );
  const resolver = new PathResolver(sources);
  const calls: ClientCall[] = [];
  const isStaticAsset = (text: string) => /\.[a-z0-9]+$/iu.test(clean(text));

  for (const source of sources) {
    const index = resolver.module(source.fileName);
    const file = path.relative(root, source.fileName);
    const lineOf = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    // One report per distinct call on a line (both branches of a ternary can be the same path).
    const reported = new Set<string>();
    const push = (node: ts.Node, call: Omit<ClientCall, "file" | "line">) => {
      const line = lineOf(node);
      const key = JSON.stringify([line, call]);
      if (reported.has(key)) return;
      reported.add(key);
      calls.push({ file, line, ...call });
    };

    /** Checks a path argument of an API helper (relative to the API base). */
    // A path tells something only if one segment is a fixed word (`/${path}` does not).
    const informative = (text: string) =>
      segments(clean(text)).some((segment) => !segment.includes("\u0000"));
    /** Reports what an API helper's path resolves to (relative to the API base). */
    const reportApi = (node: ts.Node, results: Resolved[], method: string | undefined) => {
      for (const result of results) {
        if (result.kind === "external" || result.kind === "dynamic" || result.kind === "apiBase")
          continue;
        if (result.kind === "unresolved") {
          push(node, { path: result.name, method, suffixOnly: false, problem: "unresolved" });
          continue;
        }
        // A path with no fixed word (`${base}${pathOrUrl}` inside a helper) says nothing.
        if (!informative(result.text)) continue;
        push(node, {
          path: clean(result.text),
          method,
          suffixOnly: result.kind === "suffix",
          prefixOnly: result.open === true && result.kind !== "suffix"
        });
      }
    };

    /** Reports what a browser call's URL resolves to (the web origin, where /api is the API). */
    const reportRaw = (
      node: ts.Node,
      results: Resolved[],
      method: string | undefined,
      viaNewUrl: boolean
    ) => {
      for (const result of results) {
        if (result.kind === "unresolved") {
          push(node, { path: result.name, method, suffixOnly: false, problem: "unresolved" });
          continue;
        }
        if (result.kind !== "path" && result.kind !== "api" && result.kind !== "suffix") continue;
        if (!informative(result.text)) continue;
        // Only a web-origin file is a static asset; an API URL ending in .csv is an API call.
        if (result.kind === "path" && isStaticAsset(result.text)) continue;
        const prefixOnly = result.open === true && result.kind !== "suffix";
        if (result.kind === "api" && !viaNewUrl) {
          push(node, { path: clean(result.text), method, suffixOnly: false, prefixOnly });
          continue;
        }
        // A browser call on a base this check cannot see may be any origin (a model endpoint,
        // a CDN); only its API-base form (kind "api") is an API call.
        if (result.kind === "suffix") continue;
        const text = clean(result.text);
        if (text === "/api" || text.startsWith("/api/")) {
          push(node, { path: clean(text.slice(4)), method, suffixOnly: false, prefixOnly });
          continue;
        }
        // A relative API path on the web origin reaches the SPA fallback, not the API; with
        // `new URL("/x", readApiBaseUrl())` the leading slash replaces the /api base.
        if (viaNewUrl || prefixes.has(segments(text)[0] ?? ""))
          push(node, {
            path: text,
            method,
            suffixOnly: false,
            problem: viaNewUrl ? "url_drops_api_base" : "bypasses_api_base"
          });
      }
    };

    /** A link or window.open: checked only when it points at the API itself. */
    const checkNavigationTarget = (target: ts.Expression) => {
      for (const result of resolver.resolve(index, target))
        if (result.kind === "api" && informative(result.text))
          push(target, { path: clean(result.text), method: "GET", suffixOnly: false });
    };

    /** Nodes already checked as a request's path, so the literal pass does not repeat them. */
    const checked = new Set<ts.Node>();
    // The whole argument: a path inside String(...) or a ternary is part of the checked call.
    const markChecked = (node: ts.Node) => {
      checked.add(node);
      ts.forEachChild(node, markChecked);
    };
    const apiArgument = (argument: ts.Expression, method: string | undefined) => {
      markChecked(argument);
      reportApi(argument, resolver.resolve(index, argument), method);
    };
    const rawArgument = (
      argument: ts.Expression,
      method: string | undefined,
      viaNewUrl: boolean
    ) => {
      markChecked(argument);
      reportRaw(argument, resolver.resolve(index, argument), method, viaNewUrl);
    };
    /** An unambiguous API path: on the API base, under /v1/, or under /businesses/<id>/. */
    const unmistakablyApi = (result: Resolved) =>
      result.kind === "api" ||
      ((result.kind === "path" || result.kind === "suffix") &&
        (result.text.startsWith("/v1/") ||
          result.text === "/businesses/\u0000" ||
          result.text.startsWith("/businesses/\u0000/")));

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = calleeName(node);
        const identity = resolver.calleeIdentity(index, node.expression);
        const effective = identity.name || callee;
        const argument = node.arguments?.[0];
        if (argument !== undefined) {
          // A plain call matches function wrappers; a method call matches method wrappers.
          const wrapper = !ts.isCallExpression(node)
            ? undefined
            : ts.isIdentifier(node.expression)
              ? resolver.scopedWrapper(index, node.expression)
              : resolver.methodWrapperFor(index, node);
          const receiver = ts.isPropertyAccessExpression(node.expression)
            ? node.expression.expression.getText()
            : "";
          const xhrMethod =
            ts.isCallExpression(node) &&
            callee === "open" &&
            node.arguments.length >= 2 &&
            !/(?:^|\.)(?:window|location|document)$/u.test(receiver) &&
            ((ts.isStringLiteral(argument) &&
              /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/iu.test(argument.text)) ||
              (ts.isIdentifier(argument) && /method/iu.test(argument.text)));
          if (ts.isNewExpression(node) && (callee === "EventSource" || callee === "WebSocket")) {
            rawArgument(argument, "GET", false);
          } else if (ts.isNewExpression(node) && callee === "Request") {
            rawArgument(argument, resolver.methodAt(index, argument), false);
          } else if (ts.isNewExpression(node) && callee === "URL") {
            const base = node.arguments?.[1];
            if (base !== undefined && apiBasePattern.test(base.getText()))
              rawArgument(argument, resolver.methodAt(index, node), true);
            // `new URL("/api/x", location.origin)` is a web-origin URL: /api/ is the API.
            else if (base !== undefined && /origin/u.test(base.getText()))
              rawArgument(argument, resolver.methodAt(index, node), false);
          } else if (apiHelpers.has(effective)) {
            apiArgument(
              argument,
              resolver.methodAt(index, argument) ??
                (Object.hasOwn(methodByHelper, effective) ? methodByHelper[effective] : undefined)
            );
          } else if (xhrMethod) {
            // XMLHttpRequest.open(method, url)
            const url = node.arguments![1]!;
            rawArgument(
              url,
              ts.isStringLiteral(argument) ? argument.text.toUpperCase() : undefined,
              false
            );
          } else if (wrapper !== undefined) {
            for (const site of [wrapper, ...wrapper.extra]) {
              const methodArgument =
                site.methodParameter === undefined
                  ? undefined
                  : node.arguments?.[site.methodParameter];
              const method =
                methodArgument !== undefined && ts.isStringLiteral(methodArgument)
                  ? methodArgument.text.toUpperCase()
                  : site.method;
              for (const passed of node.arguments ?? []) markChecked(passed);
              const results = resolver.resolveWrapperCall(site, index, node.arguments);
              if (apiHelpers.has(site.callee)) reportApi(node, results, method);
              else reportRaw(node, results, method, false);
            }
          } else if (!identity.project && isRawCallee(effective)) {
            rawArgument(argument, resolver.methodAt(index, argument), false);
          } else if (
            (callee === "open" || navigationCallees.has(callee)) &&
            isNavigation(argument)
          ) {
            markChecked(argument);
            checkNavigationTarget(argument);
          } else if (cacheKeyCallees.has(callee)) {
            // Every cache key names a path prefix; each must prefix a route.
            for (const key of node.arguments ?? []) {
              markChecked(key);
              for (const result of resolver.resolve(index, key)) {
                if (result.kind !== "path" && result.kind !== "api") continue;
                const text = clean(result.text);
                if (prefixes.has(segments(text)[0] ?? ""))
                  push(key, { path: text, method: undefined, suffixOnly: false, prefixOnly: true });
              }
            }
          }
        }
      }
      if (
        ts.isJsxAttribute(node) &&
        navigationAttributes.has(node.name.getText()) &&
        node.initializer !== undefined
      ) {
        const value = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (value !== undefined) {
          markChecked(value);
          checkNavigationTarget(value as ts.Expression);
        }
      }

      // Unmistakable API URLs held as data (endpoint lists, a WebSocket URL, a URL shown to the
      // user, a path passed to an injected request function): checked wherever they appear.
      // Base declarations are checked as prefixes; other paths must match a route.
      const parent = node.parent as ts.Node | undefined;
      const nested =
        parent !== undefined &&
        ((ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
          ts.isTemplateSpan(parent));
      const builderCall =
        ts.isCallExpression(node) && resolver.builderOf(index, node) !== undefined;
      if (
        !nested &&
        !checked.has(node) &&
        (pieces(node) !== null || builderCall) &&
        !isComparison(node)
      ) {
        // In navigation (`a.href = ...`, `pushState`) only a URL on the API base is an API call.
        const navigation = isNavigation(node);
        for (const result of resolver.resolve(index, node as ts.Expression)) {
          if (!unmistakablyApi(result) || !("text" in result)) continue;
          if (navigation && result.kind !== "api") continue;
          const text = clean(result.text);
          if (!informative(text) || (result.kind === "path" && isStaticAsset(text))) continue;
          const suffixOnly = result.kind === "suffix";
          const prefixOnly =
            !suffixOnly &&
            (result.open === true ||
              (parent !== undefined &&
                ((ts.isVariableDeclaration(parent) && parent.initializer === node) ||
                  (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
                  (ts.isPropertyDeclaration(parent) && parent.initializer === node) ||
                  // `url.replace(/x$/, "/v1/shop-system")`: a base that is extended later.
                  (ts.isCallExpression(parent) &&
                    ["replace", "replaceAll"].includes(calleeName(parent)) &&
                    parent.arguments[1] === node))));
          push(node, { path: text, method: undefined, suffixOnly, prefixOnly });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

/**
 * Edge-only routes (supabase/functions/api) with the methods their code accepts. A route whose
 * method cannot be read from the code accepts any method.
 */
export function edgeOnlyRoutes(source: string): RouteEntry[] {
  const keyPaths = new Map(
    [...source.matchAll(/(\w+): match\("([^"]+)"\)/gu)].map((match) => [match[1]!, match[2]!])
  );
  const methods = new Map<string, Set<string>>();
  const accept = (routePath: string, method: string) => {
    const set = methods.get(routePath) ?? new Set<string>();
    set.add(method);
    methods.set(routePath, set);
  };
  // `params(routes.key, path) ... && request.method === "M"` on one line.
  for (const match of source.matchAll(
    /params\(routes\.(\w+), path\)[^\n]*?request\.method === "(\w+)"/gu
  ))
    accept(keyPaths.get(match[1]!)!, match[2]!);
  // `const v = params(routes.a, path) ?? params(routes.b, path);` then `if (v && request.method === "M")`.
  for (const match of source.matchAll(
    /const (\w+) =\s*((?:params\(routes\.\w+, path\)(?:\s*\?\?\s*)?)+);/gu
  )) {
    const keys = [...match[2]!.matchAll(/routes\.(\w+)/gu)].map((key) => key[1]!);
    const uses = new RegExp(`\\b${match[1]} && request\\.method === "(\\w+)"`, "gu");
    for (const use of source.matchAll(uses))
      for (const key of keys) accept(keyPaths.get(key)!, use[1]!);
  }
  // `request.method === "M" && path === "/x"` and `request.method === "M" && (path === "/a" ||
  // path === "/b")` (public routes, health).
  for (const match of source.matchAll(
    /request\.method === "(\w+)"\s*&&\s*(\([^)]*\)|path === "\/[^"]+")/gu
  ))
    for (const routePath of match[2]!.matchAll(/path === "(\/[^"]+)"/gu))
      accept(routePath[1]!, match[1]!);
  // `if (request.method !== "GET") return ...;` guards every path compared after it (handler.ts).
  const getOnlyFrom = source.search(/if \(request\.method !== "GET"\)/u);
  if (getOnlyFrom !== -1)
    for (const match of source.slice(getOnlyFrom).matchAll(/path === "(\/[^"]+)"/gu))
      if (!methods.has(match[1]!)) accept(match[1]!, "GET");
  const routePaths = new Set([
    ...keyPaths.values(),
    ...[...source.matchAll(/path === "(\/[^"]+)"/gu)].map((match) => match[1]!)
  ]);
  return [...routePaths].flatMap((routePath) => {
    const accepted = methods.get(routePath);
    return accepted === undefined
      ? [{ method: "*", path: routePath }]
      : [...accepted].map((method) => ({ method, path: routePath }));
  });
}

/**
 * Android API calls: every path built in a file that defines request(), and every string built on
 * GROGONI_API_ORIGIN anywhere (concatenations included).
 */
export function extractAndroidCalls(files: string[]): ClientCall[] {
  const calls: ClientCall[] = [];
  const methodPattern = /"(GET|POST|PUT|PATCH|DELETE)"/u;
  for (const file of files) {
    let source = readFileSync(file, "utf8");
    const apiClient = /fun request\(/u.test(source);
    if (!apiClient && !source.includes("GROGONI_API_ORIGIN")) continue;
    // `val base = BuildConfig.GROGONI_API_ORIGIN` then "$base/..." or base + "/...": rewrite each
    // use of such a name as the origin itself so the strings below are read as API URLs.
    for (const match of source.matchAll(
      /\b(?:val|var)\s+(\w+)\s*(?::\s*String)?\s*=\s*(?:BuildConfig\.)?GROGONI_API_ORIGIN\b/gu
    )) {
      const name = match[1]!;
      source = source
        .replace(
          new RegExp(`"\\$\\{${name}\\}|"\\$${name}\\b`, "gu"),
          '"${BuildConfig.GROGONI_API_ORIGIN}'
        )
        .replace(new RegExp(`\\b${name}\\s*\\+\\s*"`, "gu"), '"${BuildConfig.GROGONI_API_ORIGIN}');
    }
    // A string built with `+` across lines is read as one line (at its first line); the lines it
    // absorbed are left empty so every later line keeps its number.
    const lines = source.split("\n");
    for (let index = 0; index < lines.length - 1; index++)
      while (
        index < lines.length - 1 &&
        (/\+\s*$/u.test(lines[index]!) || /^\s*\+/u.test(lines[index + 1]!))
      ) {
        const next = lines.findIndex((line, position) => position > index && line.trim() !== "");
        if (next === -1) break;
        lines[index] = `${lines[index]!.replace(/\s*$/u, "")} ${lines[next]!.trim()}`;
        lines[next] = "";
      }
    lines.forEach((line, index) => {
      // A string may start with a template: "${BuildConfig.GROGONI_API_ORIGIN}/auth/..." is an
      // absolute call; "$base/documents/ocr" has an unknown base and is matched as a suffix.
      const expression =
        /"((?:\$\{[^}]+\}|\$[A-Za-z_]\w*)?)(\/[A-Za-z][^"]*)"((?:\s*\+\s*(?:"[^"]*"|[A-Za-z_][\w.]*(?:\([^()]*\))?))*)/gu;
      for (const match of line.matchAll(expression)) {
        const prefix = match[1]!;
        const onOrigin = prefix.includes("GROGONI_API_ORIGIN");
        if (!apiClient && !onOrigin) continue;
        const suffixOnly = prefix !== "" && !onOrigin && !/ORIGIN|BASE_URL|[Oo]rigin/u.test(prefix);
        let value = match[2]!;
        for (const operand of match[3]!.matchAll(
          /\+\s*("([^"]*)"|[A-Za-z_][\w.]*(?:\([^()]*\))?)/gu
        ))
          value += operand[2] ?? "\u0000";
        value = value
          .split("?")[0]!
          .replace(/\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_.]*/gu, "\u0000")
          .replace(/\/+$/u, "");
        calls.push({
          file: path.relative(root, file),
          line: index + 1,
          path: value,
          // request()'s method argument: on this line, or alone on the line above when the call
          // is split across lines.
          method:
            methodPattern.exec(line.slice(0, match.index))?.[1] ??
            /^\s*(?:\w+\s*=\s*)?(?:request\(\s*)?"(GET|POST|PUT|PATCH|DELETE)",?\s*$/u.exec(
              lines[index - 1] ?? ""
            )?.[1],
          suffixOnly
        });
      }
    });
  }
  return calls;
}

function filesUnder(directory: string, extension: RegExp) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extension.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** The `/businesses/:id/<group>` group a route belongs to, whatever its id parameter is named. */
export function businessRouteGroup(routePath: string): string | undefined {
  return /^\/businesses\/:[^/]+\/([^/]+)/u.exec(routePath)?.[1];
}

/**
 * Edge routes outside the domain layer that production can actually reach: index.ts sends only
 * /realtime, /v1/realtime/* and /internal/jobs/* to application-routes; public routes and the
 * health routes in handler.ts are always reachable.
 */
export function reachableEdgeRoutes(sources: {
  application: string;
  handler: string;
  publicRoutes: string;
}): RouteEntry[] {
  return [
    ...edgeOnlyRoutes(sources.application).filter(
      (route) =>
        route.path === "/realtime" ||
        route.path.startsWith("/v1/realtime/") ||
        route.path.startsWith("/internal/jobs/")
    ),
    ...edgeOnlyRoutes(sources.handler),
    ...edgeOnlyRoutes(sources.publicRoutes)
  ];
}

export async function checkApiRouteCoverage() {
  process.env.NODE_ENV ??= "test";
  const { createEdgeDomainRoutes } = await import("../services/api/src/edge-domain-routes.ts");
  const { runtimeToolRegistry } = await import("../packages/tool-core/src/registry/index.ts");
  const domain = await createEdgeDomainRoutes({
    transaction: () => Promise.reject(new Error("The inventory never opens a transaction."))
  });
  const edgeFile = (name: string) =>
    readFileSync(path.join(root, "supabase/functions/api", name), "utf8");
  const edgeRoutes = reachableEdgeRoutes({
    application: edgeFile("application-routes.ts"),
    handler: edgeFile("handler.ts"),
    publicRoutes: edgeFile("public-routes.ts")
  });
  const { daemonLaneRoutes } = await import("../services/api/src/daemon/edge-lane.ts");
  const inventory = [
    ...domain.inventory.filter((route) => route.method !== "HEAD"),
    // Served by the daemon lane outside the domain layer (index.ts routes /v1/daemon/* to it).
    ...daemonLaneRoutes.map((route) => ({ ...route, websocket: false }))
  ];
  const inventoryPaths = new Set(inventory.map((route) => route.path));
  // A path the method-aware inventory also has keeps the inventory's methods (domain routes are
  // matched first in production).
  const routes: RouteEntry[] = [
    ...inventory,
    ...edgeRoutes.filter((route) => !inventoryPaths.has(route.path))
  ];
  const routesForMatching = routes.flatMap((route) =>
    route.method === "*"
      ? ["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => ({ ...route, method }))
      : [route]
  );

  const contract = JSON.parse(
    readFileSync(
      path.join(root, "packages/tool-core/src/contracts/api-route-coverage.json"),
      "utf8"
    )
  ) as CoverageContract;
  const failures: string[] = [];

  // 1. Client calls resolve to routes.
  const calls = [
    ...extractWebCalls(sourceFiles(path.join(root, "apps/web/src")), routesForMatching),
    ...extractAndroidCalls(filesUnder(path.join(root, "apps/android/app/src/main"), /\.kt$/u))
  ];
  const usedExceptions = new Set<number>();
  for (const call of calls) {
    const shown = call.path.replaceAll("\u0000", "${}");
    const problem =
      call.problem === undefined
        ? (() => {
            const result = findRoute(routesForMatching, call);
            if (result.status === "ok") return undefined;
            return result.status === "missing"
              ? `calls ${call.method ?? "?"} ${shown}, which no API route serves.`
              : `calls ${call.method} ${shown}; the route only accepts ${result.methods.join(", ")}.`;
          })()
        : call.problem === "unresolved"
          ? `passes ${shown} as an API path, which this check cannot resolve; declare it as a path constant or list it in clientPathExceptions.`
          : call.problem === "bypasses_api_base"
            ? `fetches ${shown} relative to the web app, which serves the SPA there; use readApiBaseUrl() or /api${shown}.`
            : `builds new URL("${shown}", apiBase); the leading slash drops the /api base.`;
    if (problem === undefined) continue;
    const exception = contract.clientPathExceptions.findIndex(
      (entry) => entry.file === call.file && entry.path === shown
    );
    if (exception !== -1) {
      usedExceptions.add(exception);
      continue;
    }
    failures.push(`${call.file}:${call.line} ${problem}`);
  }
  contract.clientPathExceptions.forEach((entry, index) => {
    if (!usedExceptions.has(index))
      failures.push(
        `Stale client path exception ${entry.file} ${entry.path}: the call is gone or now resolves; remove the entry.`
      );
  });

  // 2. Business route groups are classified, and named tools exist.
  const mcpSource = filesUnder(path.join(root, "services/api/src/mcp"), /\.ts$/u)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const tools = new Set([
    ...Object.keys(runtimeToolRegistry),
    ...[...mcpSource.matchAll(/name: "([a-z_]+\.[a-z_.]+)"/gu)].map((match) => match[1]!)
  ]);
  const groups = new Set(
    routes
      .map((route) => businessRouteGroup(route.path))
      .filter((group): group is string => group !== undefined)
  );
  for (const group of groups)
    if (contract.businessRouteGroups[group] === undefined)
      failures.push(
        `Business route group "${group}" is not classified in api-route-coverage.json (tool, exempt, or gap).`
      );
  for (const [group, entry] of Object.entries(contract.businessRouteGroups)) {
    if (!groups.has(group))
      failures.push(`api-route-coverage.json lists "${group}", which has no routes; remove it.`);
    if (entry.status === "tool")
      for (const tool of entry.tools)
        if (!tools.has(tool))
          failures.push(`Group "${group}" names tool "${tool}", which does not exist.`);
  }

  const counts = Object.values(contract.businessRouteGroups).reduce<Record<string, number>>(
    (total, entry) => ({ ...total, [entry.status]: (total[entry.status] ?? 0) + 1 }),
    {}
  );
  return {
    failures,
    summary: {
      routes: routes.length,
      clientCalls: calls.length,
      clientPathExceptions: contract.clientPathExceptions.length,
      businessRouteGroups: groups.size,
      ...counts,
      gaps: Object.entries(contract.businessRouteGroups)
        .filter(([, entry]) => entry.status === "gap")
        .map(([group]) => group)
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { failures, summary } = await checkApiRouteCoverage();
  console.log(JSON.stringify(summary, null, 2));
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log("PASS every client call resolves and every business route group is classified.");
  process.exit(0);
}
