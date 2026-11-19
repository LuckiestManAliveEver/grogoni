import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerCp2Routes } from "./cp2/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";

export interface EdgeRouteInventoryEntry {
  method: string;
  path: string;
  websocket: boolean;
}

/**
 * Every CP2 and MCP route, in registration order (route matching takes the first hit).
 *
 * The Edge runtime used to compute this at every isolate start by registering the whole API on a
 * throwaway Fastify app. That startup work was most of the ~1.1 s of CPU each isolate used, which
 * got every isolate retired after one request (shutdown reason EarlyDrop, measured 2026-11-19), so
 * every request paid a cold start. The list is now generated at build time into
 * edge-route-inventory.generated.ts (scripts/generate-edge-route-inventory.ts); a gate test keeps
 * the committed list identical to this live registration.
 */
export async function collectEdgeRouteInventory(): Promise<EdgeRouteInventoryEntry[]> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const inventory: EdgeRouteInventoryEntry[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method])
      inventory.push({ method, path: route.url, websocket: route.websocket === true });
  });
  const store = registerCp2Routes(app);
  registerMcpRoutes(app, { store, allowedOrigins: [], publicOrigin: "https://grogoni.com/api" });
  await app.ready();
  await app.close();
  return inventory;
}
