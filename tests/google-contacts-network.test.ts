import { describe, expect, it, vi } from "vitest";

import { fetchGoogleContacts, googleContactsScope } from "../services/api/src/cp2/google-contacts";
import { createOAuthStartPayload, getOAuthProviderConfig } from "../services/api/src/cp2/oauth";

describe("Google Contacts network seeding", () => {
  it("requests explicit read-only contact consent for the account-linking flow", () => {
    const provider = getOAuthProviderConfig("google");
    const payload = createOAuthStartPayload({
      provider,
      redirectUri: "https://grogoni.example/auth/oauth/callback",
      scopes: [...provider.scopes, googleContactsScope]
    });
    const authorizationUrl = new URL(payload.authorizationUrl);

    expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toContain(googleContactsScope);
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl.searchParams.get("include_granted_scopes")).toBe("true");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
  });

  it("maps paginated People API contacts into private network inputs", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connections: [
              {
                resourceName: "people/one",
                names: [{ displayName: "Amina N." }],
                emailAddresses: [{ value: "AMINA@example.com" }],
                phoneNumbers: [{ value: "+254700000001" }]
              }
            ],
            nextPageToken: "next"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connections: [
              {
                resourceName: "people/two",
                emailAddresses: [{ value: "second@example.com" }]
              }
            ]
          }),
          { status: 200 }
        )
      );

    const contacts = await fetchGoogleContacts({ accessToken: "private-token", fetchImpl });

    expect(contacts).toEqual([
      {
        name: "Amina N.",
        phone: "+254700000001",
        email: "AMINA@example.com",
        providerSubject: "people/one",
        relationship: "interaction"
      },
      {
        name: "second@example.com",
        phone: null,
        email: "second@example.com",
        providerSubject: "people/two",
        relationship: "interaction"
      }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    const secondUrl = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(firstUrl.searchParams.get("personFields")).toBe("names,emailAddresses,phoneNumbers");
    expect(firstUrl.searchParams.get("sources")).toBe("READ_SOURCE_TYPE_CONTACT");
    expect(secondUrl.searchParams.get("pageToken")).toBe("next");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer private-token"
    });
  });

  it("does not expose provider error bodies when contact permission fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "provider secret detail" } }), {
        status: 403
      })
    );

    await expect(fetchGoogleContacts({ accessToken: "expired", fetchImpl })).rejects.toMatchObject({
      code: "google_contacts_sync_failed",
      statusCode: 409
    });
  });
});
