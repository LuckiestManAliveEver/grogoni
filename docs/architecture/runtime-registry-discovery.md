# Runtime registry: connected GitHub/Hugging Face discovery

See ADR-device-independent-runtime-and-registry-discovery.md for the decision record. This document
describes the resulting shape.

## Why this exists

Users need to find agents and models from three sources — Grogoni's own catalog, GitHub, and Hugging
Face — without React ever talking to GitHub or Hugging Face directly, and without a search request
downloading full model weights or cloning a repository merely to render results. Harness discovery
(importing a third-party executable `AgentRuntimeAdapter`) was retired - see
`ADR-collapse-harness-into-agent.md` - engine choice is now a declared property of an agent
definition (`AgentDefinition.runtimeAdapterId`), never a separately imported/searched kind.

## Contracts

All types live in `packages/shared-types/src/runtime-registry.ts`.

```text
RuntimeRegistryAdapter
  id: "grogoni" | "github" | "huggingface"
  search(query, context) → RuntimeRegistrySearchItem[]
  inspect(ref, context)  → RuntimeRegistryResourceDetails
```

Three adapters implement it, each wrapping pre-existing catalog code rather than re-implementing
provider access:

| Adapter                      | Wraps                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `GrogoniCatalogRegistryAdapter` | `cp2_model_catalog`, `cp2_agent_catalog`, `AgentRuntimeAdapterRegistry` |
| `GitHubRegistryAdapter`      | `github-model-catalog.ts`, `github-agent-catalog.ts`                    |
| `HuggingFaceRegistryAdapter` | `huggingface-model-catalog.ts`, `huggingface-agent-catalog.ts`          |

`search` results are normalized into `RuntimeRegistrySearchItem` — provider, kind, identity,
ownership, popularity/recency signals, license, and a `compatibility` verdict. Provider-specific raw
metadata is kept out of the normalized item and only surfaces via `inspect`'s
`providerMetadata`/`readmeExcerpt`/`files` fields, fetched on demand for one specific resource, never
for a page of search results.

## Unified search

`GET /v1/runtime-registry/search?q=&kind=&providers=&cursor=&limit=` fans out to every requested
provider concurrently and never lets one provider's failure fail the whole request:

```json
{
  "items": [/* normalized RuntimeRegistrySearchItem[] */],
  "providers": {
    "grogoni": { "status": "ok" },
    "github": { "status": "error", "errorMessage": "..." },
    "huggingface": { "status": "ok" }
  }
}
```

Enforced server-side: a minimum query length, a bounded result count, short-lived (order of tens of
seconds) in-memory caching, and cache-key separation between public and connected-account results —
an authenticated, connected search never shares a cache entry with an anonymous or differently-
authenticated one. `GET /v1/runtime-registry/resources/:provider/:id` returns one resource's full
`inspect` detail.

## Connected accounts

`ExternalRegistryConnection` (`{id, accountId, provider, externalAccountId, externalUsername,
status, scopes, createdAt, updatedAt}`) is the only shape ever returned to the browser — it never
contains a token. A connection is established by pasting a personal access token
(`POST /v1/external-connections/github` or `/huggingface`), validated with one real API call
(`GET api.github.com/user` / `GET huggingface.co/api/whoami-v2`) before anything is persisted,
encrypted at rest with the same primitive already used for social-login OAuth tokens
(`encryptOAuthToken`/`decryptOAuthToken` in `services/api/src/cp2/oauth.ts`), and resolved
server-side only, inside the matching `RuntimeRegistryAdapter`, when building an authenticated
provider request. `DELETE /v1/external-connections/:id` deletes the stored encrypted token, not just
a status flag. `GET /v1/external-connections` lists the caller's own connections. Connecting an
account unlocks higher rate limits and private/gated resources the account has access to; public
search works with no connection at all.

## Import lifecycle

```text
DISCOVERED → INSPECTING → VALIDATED → IMPORTING → REGISTERED → PROVISIONING → READY → ACTIVE
```

with terminal failure states `INSPECTION_FAILED`, `VALIDATION_FAILED`, `IMPORT_FAILED`,
`PROVISIONING_FAILED`, `INCOMPATIBLE`, `ACCESS_REQUIRED`, `LICENSE_CONFIRMATION_REQUIRED`. No single
boolean `installed` flag collapses these states. Every import that reaches `REGISTERED` carries a
`RuntimeAssetProvenance` (provider, external id, repository URL, owner, revision/commit SHA,
filename, checksum, license, import time) pinned at that moment — an upstream change never mutates
an already-registered/active asset; it can only ever be surfaced later as "update available."

**Agents**: a GitHub repository's manifest is fetched via a metadata/content API call (never a repo
clone), validated with the existing `validatePortableAgentManifest` (already denylists device paths,
credentials, and executable references), and on success registered as a plain declarative
`PortableAgentManifest` record — no code from the repository is ever executed.

**Models**: a Hugging Face repository's file listing is inspected for a compatible artifact
(currently `.gguf`, reusing the existing filtering in `huggingface-model-catalog.ts`) without
downloading it; on selection, its checksum/license/revision are captured as provenance before any
provisioning step, and provisioning never routes the artifact through the browser.

## What Grogoni independently validates

Provider metadata (stars, claimed license, README content) is discovery input, never authoritative
runtime truth. Registration always re-validates structurally against Grogoni's own contracts
(`PortableAgentManifest`, model artifact compatibility) regardless of what the source
repository/model card claims.
