import { routes } from "./routes";

import { type ActiveBusiness } from "./grogoni-application-shared";

export function isGrogoniId(value: unknown): value is string {
  return (
    typeof value === "string" && /^grogoni\.[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/iu.test(value.trim())
  );
}

export function normalizeGrogoniId(value: string): string {
  return value.trim().toLowerCase();
}

export function createPublicStorefrontUrl(business: ActiveBusiness): string {
  return createStorefrontUrl(normalizeGrogoniId(business.grogoniId));
}

export function createStorefrontUrl(agentId: string): string {
  const trimmedAgentId = agentId.trim();
  const normalizedAgentId = isGrogoniId(trimmedAgentId)
    ? normalizeGrogoniId(trimmedAgentId)
    : trimmedAgentId;
  const localOrigins = ["localhost", "127.0.0.1", "0.0.0.0"];

  if (localOrigins.includes(window.location.hostname)) {
    return `${window.location.origin}${routes.publicAgent(normalizedAgentId)}`;
  }

  return `https://grogoni.com${routes.publicAgent(normalizedAgentId)}`;
}
