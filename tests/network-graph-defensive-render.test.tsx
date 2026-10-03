// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeNetworkGraph } from "../apps/web/src/hooks/useNetworkState";
import type { NetworkGraphSummary, SessionResponse } from "../apps/web/src/grogoni-application-shared";

vi.mock("../apps/web/src/api-helpers", () => ({
  postJson: vi.fn()
}));

const { IdentityNetworkOnboardingCard } =
  await import("../apps/web/src/IdentityNetworkOnboardingCard");

function session(): SessionResponse {
  return {
    account: {
      id: "account-1",
      primaryAuthChannel: "email",
      primaryAuthDestination: "owner@example.com",
      identityLevel: "strong"
    },
    user: {
      id: "user-1",
      accountId: "account-1",
      displayName: "Owner",
      language: "en",
      emailAddress: "owner@example.com",
      emailVerificationStatus: "verified"
    },
    session: { id: "session-1", expiresAt: "2099-01-01T00:00:00.000Z" }
  };
}

describe("normalizeNetworkGraph", () => {
  it("defaults every array field when the source object has none of them", () => {
    expect(normalizeNetworkGraph({})).toMatchObject({
      nodes: [],
      edges: [],
      sources: [],
      routes: []
    });
  });

  it("defaults arrays when the source object is null or undefined", () => {
    expect(normalizeNetworkGraph(null)).toMatchObject({
      nodes: [],
      edges: [],
      sources: [],
      routes: []
    });
    expect(normalizeNetworkGraph(undefined)).toMatchObject({
      nodes: [],
      edges: [],
      sources: [],
      routes: []
    });
  });

  it("passes through an already-complete graph unchanged", () => {
    const complete: NetworkGraphSummary = {
      ownerUserId: "user-1",
      generatedAt: "2026-08-31T00:00:00.000Z",
      nodes: [
        {
          id: "node-1",
          ownerUserId: "user-1",
          displayName: "Jane",
          degree: 1,
          sourceId: "source-1"
        } as NetworkGraphSummary["nodes"][number]
      ],
      edges: [],
      sources: [],
      routes: []
    };

    expect(normalizeNetworkGraph(complete)).toEqual(complete);
  });

  it("does not invent an array for a partial object missing only one field", () => {
    const partial = { nodes: [], edges: [], routes: [] };
    expect(normalizeNetworkGraph(partial).sources).toEqual([]);
  });
});

describe("IdentityNetworkOnboardingCard against a malformed graph", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  // Regression test for the crash reported as "Cannot read properties of undefined (reading
  // 'some')": a GET /network response can be served from an IndexedDB record cached by an older
  // build (api-request-cache.ts -> local-data-repository.ts), whose schemaVersion never tracks
  // NetworkGraphSummary's shape. Before the fix, `graph?.nodes.some(...)` on line 56 of
  // IdentityNetworkOnboardingCard.tsx threw the moment `graph` was a non-null object without a
  // `nodes` array, since optional chaining only guarded the `graph` reference, not the property.
  it("renders without throwing when graph is a non-null object missing nodes", () => {
    const malformedGraph = {} as NetworkGraphSummary;

    expect(() => {
      const root = createRoot(host);
      act(() => {
        root.render(
          <IdentityNetworkOnboardingCard
            session={session()}
            graph={malformedGraph}
            oauthProviders={[]}
            oauthProvidersLoaded={true}
            onSessionChange={() => {}}
            onGoogleContacts={async () => {}}
            onPhoneContactsSync={async () => null}
          />
        );
      });
      act(() => root.unmount());
    }).not.toThrow();
  });

  it("treats a graph missing nodes the same as an empty network, not a seeded one", () => {
    const malformedGraph = { sources: [] } as unknown as NetworkGraphSummary;
    const root = createRoot(host);

    act(() => {
      root.render(
        <IdentityNetworkOnboardingCard
          session={session()}
          graph={malformedGraph}
          oauthProviders={[]}
          oauthProvidersLoaded={true}
          onSessionChange={() => {}}
          onGoogleContacts={async () => {}}
          onPhoneContactsSync={async () => null}
        />
      );
    });

    expect(host.textContent).toContain("Add your first contacts");

    act(() => root.unmount());
  });
});
