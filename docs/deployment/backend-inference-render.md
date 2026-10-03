# Deploy backend inference on Render (superseded)

This runbook described the retired topology: a private `grogoni-inference` Docker service on
Render, running Ollama against a persistent model disk, reachable from the API only over Render's
private network.

That service no longer exists. Inference now runs on Vercel, deployed independently from Render -
see [vercel-inference.md](./vercel-inference.md) for the current topology, required configuration,
rollout order, and rollback. [render-inference.md](./render-inference.md) covers the boundary
Render still enforces (it authenticates, authorizes, and proxies; it never runs a model itself).
