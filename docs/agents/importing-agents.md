# Importing portable agents

Grogoni imports logical definitions, not repository executables. An import passes through the
`AgentImporter` boundary:

1. `supports` selects an adapter for the source format.
2. `inspect` validates without persisting or executing anything.
3. `convert` returns a canonical `PortableAgentManifest`.
4. Account storage persists the definition independently from model artifacts and device state.
5. The existing native runtime resolver later combines that definition with a compatible model and
   authorized execution host.

`GrogoniManifestAgentImporter` is the first canonical adapter. GitHub and Hugging Face discovery
records are also converted to portable manifests when saved to an account. Repository runtime
labels are retained only as provenance metadata; no Python, Node, Docker, Gradio, shell command,
binary path, endpoint, or API key is imported into the runtime contract.

Future adapters may inspect LangGraph, CrewAI, AutoGen, MCP, or other projects, but must emit the
same manifest and remain subject to the same validation. Supporting a source does not authorize
running its code. A separate, isolated and explicitly configured backend adapter would still be
required for any repository code execution.

Importing does not install an agent on the current phone. Once the account definition and shop
profile are saved, every authenticated device sees the same logical agent. A local model/runtime
download is an optional execution resource and does not change agent identity.
