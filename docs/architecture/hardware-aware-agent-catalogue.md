# Hardware-aware OSS agent catalogue

The owner agent selector discovers real open-source agent projects instead of maintaining a list
of Grogoni-authored personas. Discovery has two sources:

- GitHub repositories returned by the official repository search API. Results must use a
  recognized open-source license, have at least 100 stars, carry the `ai-agents` topic, and not be
  archived, disabled, or forks.
- Public Hugging Face Gradio Spaces returned by the official semantic Space search API. Results
  must have at least 10 likes. A Space without a recognized declared license remains visible for
  provenance but cannot be selected.

The API caches successful searches for 15 minutes and short-caches upstream failures. Optional
`GITHUB_TOKEN` and `HF_TOKEN`/`HUGGINGFACE_TOKEN` values raise upstream rate limits without exposing
tokens to the browser.

## Execution boundary

Repository discovery is not permission to execute third-party code. The catalogue records source,
license, runtime, popularity, and hardware metadata, while the canonical Grogoni runtime retains its
existing authorization, confirmation, context, and tool pipeline.

```text
GitHub/Hugging Face discovery
  -> license and maturity gate
  -> execution-target compatibility ranking
  -> verified manifest cached on the device
  -> shop + device chat binding
  -> existing versioned Grogoni runtime and model assignment
```

Hugging Face Gradio Spaces expose hosted APIs, so their server hardware is shown separately from
the owner's device. GitHub projects require a restricted backend adapter and are disabled when that
path is unavailable. Their declared memory estimate applies to the backend execution target, not
the browser. Arbitrary repository code is never downloaded or evaluated in the browser.

## First-run selection and installation

When the canonical shop profile still uses `builtin:shopkeeper`, the owner application performs a
first-run bootstrap without waiting for the settings screen to open:

1. Re-read the canonical profile to avoid overwriting a concurrent or cross-device choice.
2. Discover both catalogues and reject unavailable or unlicensed candidates.
3. Select the runnable candidate with the lowest `minimumMemoryGb`; prefer no GPU, hosted execution,
   and then popularity only as deterministic tie-breakers.
4. Cache a versioned, source-bound manifest in local storage. This is the downloaded agent artifact;
   third-party repository code is not an executable browser dependency.
5. Persist the selected definition through the normal agent-profile endpoint, then bind it to the
   current shop and device. The resulting profile becomes the same `agentSettings` state consumed by
   chat.

The three writes are deliberately ordered manifest → server profile → device binding. A failure
leaves the built-in safe fallback active and can retry after connectivity changes. Model files and
model memory remain governed by the existing GGUF installation and assignment lifecycle.

Selecting a source updates the draft profile's source identity, name, description, role, and
provenance integration. It deliberately preserves the active model, instructions, knowledge,
permissions, and tool bindings. Saving creates the next normal runtime version and remains
rollback-compatible.

## Legacy and offline behavior

`builtin:shopkeeper` is retained only as a safe fallback for catalogue, storage, or persistence
outages. It is not presented as an OSS catalogue choice. Legacy profiles without an agent
definition hydrate to that fallback and trigger first-run selection. External IDs are restricted to normalized
`github:owner/repository` and `huggingface:owner/space` forms.

## API surface

```text
GET /v1/oss-agents/github?search=...
GET /v1/oss-agents/huggingface?search=...
```

Both routes return the shared `OssAgentSearchResult` contract and are consumed together by the
owner settings module, matching the existing multi-source model chooser interaction.
