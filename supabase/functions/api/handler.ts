interface Dependencies {
  checkDatabase: () => Promise<void>;
  allowedOrigins: string[];
  applicationRoutes?: (request: Request, path: string) => Promise<Response | null>;
  complete?: boolean;
}

export function createHandler({
  checkDatabase,
  allowedOrigins,
  applicationRoutes,
  complete = false
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
    const path = pathname.replace(/^(?:\/functions\/v1)?\/api(?=\/|$)/, "") || "/";
    if (applicationRoutes) {
      try {
        const result = await applicationRoutes(request, path);
        if (result) {
          for (const [name, value] of headers) result.headers.set(name, value);
          return result;
        }
      } catch {
        return Response.json(
          { code: "service_unavailable", message: "The service is temporarily unavailable." },
          { status: 503, headers }
        );
      }
    }
    if (request.method !== "GET") {
      return Response.json({ code: "route_not_found" }, { status: 404, headers });
    }
    if (path === "/health" || path === "/health/live") {
      return Response.json({ service: "api", runtime: "supabase-edge", status: "ok" }, { headers });
    }
    if (path === "/health/db" || path === "/health/ready") {
      let ok = true;
      try {
        await checkDatabase();
      } catch {
        ok = false;
      }
      const ready = path === "/health/ready";
      const available = ok && (!ready || complete);
      return Response.json(
        {
          service: "api",
          status: available ? "ok" : "unavailable",
          database: { provider: "neon", ok },
          ...(ready && !complete ? { code: "api_migration_incomplete" } : {})
        },
        { status: available ? 200 : 503, headers }
      );
    }
    return Response.json({ code: "route_not_found" }, { status: 404, headers });
  };
}
