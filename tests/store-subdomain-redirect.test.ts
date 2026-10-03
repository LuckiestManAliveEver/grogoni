import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

function uniquePhone(seed: number): string {
  return `2547013${String(seed).padStart(5, "0")}`;
}

function jsonHeaders(cookie?: string) {
  return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
}

function sessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) throw new Error("Expected a session cookie.");
  return value.split(";")[0] ?? value;
}

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  seed: number,
  name: string
): Promise<{ businessId: string; grogoniId: string; cookie: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact: uniquePhone(seed), pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = sessionCookie(signup.headers["set-cookie"]);
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(business.statusCode).toBe(200);
  const body = business.json<{ business: { id: string; grogoniId: string } }>();
  return { businessId: body.business.id, grogoniId: body.business.grogoniId, cookie };
}

// Exercises the onRequest hook in services/api/src/app.ts (docs/architecture/grogoni-id-slug-system.md).
// Nothing routes real traffic here until *.grogoni.com is registered as a wildcard custom domain
// against this service - these tests simulate that by setting the Host header directly, the same
// way a request would arrive once that infra step is done.
describe("store subdomain redirect (Host: {handle}.grogoni.com)", () => {
  it("redirects an active store handle to its canonical storefront URL", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store, webPublicUrl: "https://grogoni.com" } });
    const owner = await createOwnerBusiness(app, 1, "Subdomain Redirect Shop");
    const bareHandle = owner.grogoniId.replace(/^grogoni\./u, "");

    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `${bareHandle}.grogoni.com` }
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      `https://grogoni.com/agent/${encodeURIComponent(owner.grogoniId)}`
    );
    await app.close();
  });

  it("redirects a retired, in-cooldown handle straight to the current one", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store, webPublicUrl: "https://grogoni.com" } });
    const owner = await createOwnerBusiness(app, 2, "Renamed Subdomain Shop");
    const oldBareHandle = owner.grogoniId.replace(/^grogoni\./u, "");

    const rename = await app.inject({
      method: "PUT",
      url: `/businesses/${owner.businessId}/grogoni-id`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ handle: "new-subdomain-handle" })
    });
    expect(rename.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `${oldBareHandle}.grogoni.com` }
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://grogoni.com/agent/grogoni.new-subdomain-handle");
    await app.close();
  });

  it("returns 404 for a handle that never existed", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store, webPublicUrl: "https://grogoni.com" } });

    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "never-existed-shop.grogoni.com" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "storefront_not_found" });
    await app.close();
  });

  it("routes normally for the apex and fixed api/www subdomains", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store, webPublicUrl: "https://grogoni.com" } });

    for (const host of ["grogoni", "api.grogoni.com", "www.grogoni.com"]) {
      const response = await app.inject({
        method: "GET",
        url: "/health/ready",
        headers: { host }
      });
      expect(response.statusCode, `host=${host}`).toBe(200);
    }
    await app.close();
  });

  it("does not intercept requests to an unrelated host", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store, webPublicUrl: "https://grogoni.com" } });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { host: "example.com" }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
