import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { Cp2Error } from "../../cp2-error.js";
export function isPublicCommerceAddress(address: string): boolean {
  if (isIP(address) !== 4) return false; // IPv6 requires a separately audited public-range policy.
  const [a, b] = address.split(".").map(Number);
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a! < 224 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b! >= 16 && b! <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b! >= 64 && b! <= 127) &&
    a !== 198 &&
    !(a === 203 && b === 0)
  );
}
/** Bounded HTTPS read, pinned DNS resolution, no redirects, credentials, cookies or private networks. */
export async function readCommerceWebsite(
  urlString: string,
  limit = 2 * 1024 * 1024
): Promise<string> {
  const url = new URL(urlString);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new Cp2Error(400, "commerce_url_invalid", "Use a public HTTPS source on port 443.");
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some((result) => !isPublicCommerceAddress(result.address)))
    throw new Cp2Error(400, "commerce_private_source", "Private network sources are not allowed.");
  const address = addresses[0]!.address;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json, text/plain", "user-agent": "Grogoni-Commerce/1" },
        lookup: (_hostname, _options, callback) => callback(null, address, 4)
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Cp2Error(
              422,
              "commerce_source_response",
              "The source must return HTTP 200 without redirecting."
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            req.destroy(new Error("Source response is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("Source request timed out.")));
    req.on("error", reject);
    req.end();
  });
}
