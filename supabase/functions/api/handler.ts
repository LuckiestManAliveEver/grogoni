interface Dependencies {
  checkDatabase: () => Promise<void>;
  allowedOrigins: string[];
  applicationRoutes?: (request: Request, path: string) => Promise<Response | null>;
  complete?: boolean | (() => Promise<boolean>);
  databaseProvider?: string;
}

export function createHandler({
  checkDatabase,
  allowedOrigins,
  applicationRoutes,
  complete = false,
  databaseProvider = "postgres"
}: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });
    const origin = request.headers.get("origin");
    if (origin) {
      headers.set("Vary", "Origin");
      if (!allowedOrigins.includes(origin)) {
        return Response.json({ code: "origin_not_allowed" }, { status: 403, headers });
      }
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.set(
        "Access-Control-Expose-Headers",
        "mcp-session-id, content-disposition, x-request-id"
      );
    }
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        [
          "content-type",
          "authorization",
          "apikey",
          "x-request-id",
          "idempotency-key",
          "mcp-session-id",
          "mcp-protocol-version",
          "x-grogoni-device-id",
          "x-grogoni-device-name",
          "x-grogoni-platform",
          "x-grogoni-client",
          "x-grogoni-turn-id"
        ].join(", ")
      );
      return new Response(null, { status: 204, headers });
    }
    const pathname = new URL(request.url).pathname;
    const path =
      pathname
        .replace(/^\/functions\/v1\/[^/]+(?=\/|$)/, "")
        .replace(/^\/api(?:-candidate)?(?=\/|$)/, "") || "/";
    if (request.method === "GET" && (path === "/health" || path === "/health/live")) {
      return Response.json({ service: "api", runtime: "supabase-edge", status: "ok" }, { headers });
    }
    if (request.method === "GET" && (path === "/health/db" || path === "/health/ready")) {
      let ok = true;
      try {
        await checkDatabase();
      } catch {
        ok = false;
      }
      const ready = path === "/health/ready";
      const completeApi = !ready || (typeof complete === "function" ? await complete() : complete);
      const available = ok && completeApi;
      return Response.json(
        {
          service: "api",
          status: available ? "ok" : "unavailable",
          database: { provider: databaseProvider, ok },
          ...(ready && !completeApi ? { code: "api_migration_incomplete" } : {})
        },
        { status: available ? 200 : 503, headers }
      );
    }
    if (applicationRoutes) {
      try {
        const result = await applicationRoutes(request, path);
        if (result) {
          for (const [name, value] of headers) {
            if (name === "content-type" && result.headers.has(name)) continue;
            result.headers.set(name, value);
          }
          return result;
        }
      } catch (error) {
        const requestId = crypto.randomUUID();
        console.error(
          JSON.stringify({
            event: "edge_route_failed",
            requestId,
            method: request.method,
            route: path,
            errorType: error instanceof Error ? error.name : "UnknownError",
            table:
              typeof error === "object" &&
              error !== null &&
              "table" in error &&
              typeof error.table === "string" &&
              /^[a-z][a-z0-9_]{0,62}$/.test(error.table)
                ? error.table
                : null,
            code:
              typeof error === "object" && error !== null && "code" in error
                ? String(error.code)
                : null
          })
        );
        headers.set("x-request-id", requestId);
        return Response.json(
          { code: "service_unavailable", message: "The service is temporarily unavailable." },
          { status: 503, headers }
        );
      }
    }
    if (request.method !== "GET") {
      return Response.json({ code: "route_not_found" }, { status: 404, headers });
    }
    return Response.json({ code: "route_not_found" }, { status: 404, headers });
  };
}
