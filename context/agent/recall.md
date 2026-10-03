# Grogoni recall context

`recall.md` contains small, validated, shop-scoped lessons distilled after an attempted local
inference failed and an authorized cloud fallback succeeded. These are context records, not model
weights and not a claim that the local model was trained.

Each durable entry uses `grogoni-recall-v1` metadata and the sections `Trigger`, `Learned behavior`,
and `Failure avoided`. Entries must remain reusable and must never contain raw conversations,
credentials, personal data, transient shop facts, hidden reasoning, or unverified claims.

At inference time only lexically relevant entries may appear inside `<relevant_recall>`. Recall is
advisory: current authoritative shop records, active business policy, permissions, and verified tool
results always take precedence.
