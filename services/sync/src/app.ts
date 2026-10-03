import Fastify from "fastify";
import type { HealthResponse } from "@grogoni/shared-types";

export function buildSyncService() {
  const app = Fastify({
    logger: true
  });

  app.get("/health", async (): Promise<HealthResponse> => {
    return {
      service: "sync",
      status: "ok",
      timestamp: new Date().toISOString()
    };
  });

  return app;
}
