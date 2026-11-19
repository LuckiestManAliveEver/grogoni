// Loaded with import() by pi-agent-runtime-adapter.ts so the Pi libraries are evaluated on the
// first agent run instead of at Edge isolate startup. Named static imports here (rather than
// import() of the packages themselves) keep the bundler's tree-shaking: only what the adapter uses
// is bundled.
export { Agent } from "@earendil-works/pi-agent-core";
export { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
