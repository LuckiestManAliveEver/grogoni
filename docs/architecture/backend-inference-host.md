# Backend inference host (superseded)

This document described the retired topology: `services/ai-runtime` as a Render-private Ollama
facade (`Grogoni PWA -> public Grogoni API -> private authenticated ai-runtime -> loopback Ollama ->
model`).

`services/ai-runtime` is now a standalone Vercel deployment running `node-llama-cpp` against a
Neon-object-storage-hosted GGUF artifact - see
[inference-runtime.md](./inference-runtime.md) for the current boundary and
[../deployment/vercel-inference.md](../deployment/vercel-inference.md) for the deployment runbook.
