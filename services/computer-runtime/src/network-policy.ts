import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { ComputerNavigationPolicy } from "@grogoni/shared-types";

const privateV4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u;

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4.test(address) || address === "0.0.0.0";
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe8") ||
    address.startsWith("fe9") ||
    address.startsWith("fea") ||
    address.startsWith("feb")
  );
}

function domainMatches(hostname: string, rule: string): boolean {
  const normalized = rule.trim().toLowerCase().replace(/^\*\./u, "");
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

export async function assertNavigationAllowed(
  rawUrl: string,
  policy: ComputerNavigationPolicy
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("NAVIGATION_URL_INVALID");
  }
  if (url.username || url.password) throw new Error("NAVIGATION_CREDENTIALS_FORBIDDEN");
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:"))
    throw new Error("NAVIGATION_PROTOCOL_FORBIDDEN");
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost"))
    throw new Error("NAVIGATION_PRIVATE_NETWORK_FORBIDDEN");
  if (policy.blockedDomains.some((entry) => domainMatches(hostname, entry)))
    throw new Error("NAVIGATION_DOMAIN_BLOCKED");
  if (
    policy.allowedDomains.length > 0 &&
    !policy.allowedDomains.some((entry) => domainMatches(hostname, entry))
  )
    throw new Error("NAVIGATION_DOMAIN_NOT_ALLOWED");
  if (!policy.allowPrivateNetworks) {
    const addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
          throw new Error("NAVIGATION_DNS_FAILED");
        });
    if (addresses.some(({ address }) => privateAddress(address)))
      throw new Error("NAVIGATION_PRIVATE_NETWORK_FORBIDDEN");
  }
  return url;
}
