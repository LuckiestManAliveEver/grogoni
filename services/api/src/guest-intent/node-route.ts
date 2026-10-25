import type { FastifyInstance } from "fastify";
import { guestIntentPath } from "@grogoni/shared-types";
import { readSessionCookie, type Cp2Store } from "../cp2/store.js";
import { createMemoryGuestIntentLimiter } from "./rate-limit.js";
import {
  createGuestIntentService,
  guestIntentMaxBodyBytes,
  readGuestIntentConfiguration,
  type GuestIntentService
} from "./service.js";

/** The Node API's service: same classifier as the Edge, an in-process per-session counter. */
export function createNodeGuestIntentService(
  environment: NodeJS.ProcessEnv = process.env
): GuestIntentService {
  const configuration = readGuestIntentConfiguration(environment);
  if (configuration.disabledReason !== null)
    console.log(
      JSON.stringify({ event: "guest_intent_disabled", reason: configuration.disabledReason })
    );
  return createGuestIntentService({
    classifier: configuration.classifier,
    limiter: createMemoryGuestIntentLimiter(configuration.ratePolicy)
  });
}

/** Without a configured service the route still answers (503), so guests fall back at once. */
const unavailable = createGuestIntentService({
  classifier: null,
  limiter: createMemoryGuestIntentLimiter(),
  report: () => undefined
});

export function registerGuestIntentRoute(
  routes: FastifyInstance,
  input: { store: Cp2Store; service?: GuestIntentService }
) {
  routes.post(guestIntentPath, { bodyLimit: guestIntentMaxBodyBytes }, async (request, reply) => {
    const startedAt = Date.now();
    const session = input.store.getSession(readSessionCookie(request.headers.cookie));
    const result = await (input.service ?? unavailable).handle({
      session: session === null ? null : { sessionId: session.session.id },
      body: request.body,
      startedAt
    });
    reply.header("cache-control", "no-store");
    for (const [name, value] of Object.entries(result.headers ?? {})) reply.header(name, value);
    return reply.code(result.status).send(result.body);
  });
}
