import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { NetworkGraphSummary } from "../packages/shared-types/src";

interface VerifyOtpResponse {
  session: {
    id: string;
  };
}

interface CreateBusinessResponse {
  business: {
    id: string;
  };
}

interface ProductResponse {
  id: string;
  name: string;
}

describe("CP2 store persistence", () => {
  it("repairs empty legacy session security fields while hydrating", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    await createOwnerBusiness(app);
    const snapshot = store.snapshot();
    const legacySession = snapshot.sessions[0];
    expect(legacySession).toBeDefined();
    if (legacySession === undefined) throw new Error("Expected a session fixture.");
    legacySession.userAgentHash = "";
    legacySession.refreshTokenHash = "   ";

    const restoredStore = createCp2Store();
    restoredStore.hydrateSnapshot(snapshot);
    expect(restoredStore.snapshot().sessions[0]).toMatchObject({
      userAgentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      refreshTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });

    await app.close();
  });

  it("hydrates sessions, PIN hashes, catalogue data, and network data from a snapshot", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { business, sessionCookie } = await createOwnerBusiness(app);

    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${business.id}/products`,
      {
        name: "Sugar",
        quantity: 8,
        unit: "kg",
        buyingPrice: 100,
        sellingPrice: 130
      },
      sessionCookie
    );
    await postJson<NetworkGraphSummary>(
      app,
      "/network/sync/contacts",
      {
        contacts: [
          {
            name: "Jane Supplier",
            phone: "+254700000901"
          }
        ]
      },
      sessionCookie
    );

    const restoredStore = createCp2Store();
    restoredStore.hydrateSnapshot(store.snapshot());
    const restoredApp = buildApi({ cp2: { store: restoredStore } });

    const session = await restoredApp.inject({
      method: "GET",
      url: "/session",
      headers: {
        cookie: sessionCookie
      }
    });
    expect(session.statusCode).toBe(200);

    const products = await getJson<ProductResponse[]>(
      restoredApp,
      `/businesses/${business.id}/products`,
      sessionCookie
    );
    expect(products).toEqual([expect.objectContaining({ id: product.id, name: "Sugar" })]);

    const pinStatus = await getJson<{ hasPin: boolean }>(
      restoredApp,
      "/auth/pin/status",
      sessionCookie
    );
    expect(pinStatus.hasPin).toBe(true);

    const pinLogin = await postJson<VerifyOtpResponse>(restoredApp, "/auth/pin/login", {
      channel: "phone",
      destination: "254700000900",
      pin: "3927"
    });
    expect(pinLogin.session.id).toBeTruthy();

    const graph = await getJson<NetworkGraphSummary>(restoredApp, "/network", sessionCookie);
    expect(graph.nodes.map((node) => node.displayName)).toContain("Jane Supplier");

    await app.close();
    await restoredApp.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>
): Promise<CreateBusinessResponse & { sessionCookie: string }> {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: "254700000900",
      pin: "3927"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "Persistent Shop",
      language: "en"
    },
    sessionCookie
  );

  return {
    ...business,
    sessionCookie
  };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      ...jsonHeaders(),
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      cookie
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | number | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(typeof value).toBe("string");
  return String(value).split(";")[0] ?? "";
}
