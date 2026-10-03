# Browser inference staging validation — 2026-07-19

## Scope and environment

- Source commit under test: `7faeb33` plus the current staging-hardening worktree.
- Local production-shaped staging server: Vite, Chrome 143 headless, Linux host.
- Mobile profile: Playwright Pixel 5 emulation with reported 4 GB memory and 8 logical processors.
- GPU adapter: Chrome SwiftShader software WebGPU, not Android hardware.
- Physical Android/device-farm access: unavailable in this execution environment.
- Render deployment access: unavailable; the deployable staging service is defined in
  `render.yaml`, but Blueprint sync and the staging API URL remain external steps.

## Completed evidence

- `VITE_BROWSER_LOCAL_INFERENCE_ENABLED=true` was visible in the staging bundle.
- The cold model-worker capability probe initially exposed a false timeout; the timeout was raised
  to 15 seconds and transient failures now retry.
- Secured staging responses included CSP, COOP and COEP.
- Chrome reported `crossOriginIsolated=true`, IndexedDB available and the worker initialized.
- WebGPU was detected in desktop, Pixel 5 and Galaxy S9+ emulated contexts.
- The CSP permitted the approved Hugging Face transfer. Cache inspection found five successful,
  status-200 assets:
  - `tokenizer_config.json`;
  - `config.json`;
  - `tokenizer.json`;
  - `generation_config.json`;
  - `onnx/model_q4.onnx`.
- The measured q4 ONNX response was 386,495,938 bytes. Registry, quota and UI estimates were
  corrected to approximately 400 MB.
- No model credentials or prompt content were sent to the model host.
- The first complete cached load exposed an ONNX Runtime dependency on jsDelivr. Transformers.js
  set its default `wasmPaths` to that CDN, which the staging CSP correctly rejected and surfaced as
  `no available backend found. ERR: [webgpu] TypeError: Failed to fetch`.
- The worker now binds ONNX Runtime to the package's Vite-managed, same-origin WASM asset. The
  staging CSP does not need a jsDelivr exception.
- After that fix, the WebGPU model session initialized successfully and generation started.

## Incomplete or failed evidence

- A staging-only `browserInferenceMaxNewTokens=32` benchmark control was added so a short run can
  measure time-to-first-token and throughput without changing production behavior.
- The cached WebGPU model loaded in 11.65 seconds. SwiftShader did not complete the 32-token
  generation within 60 seconds, and an earlier run using the normal 160-token budget did not
  complete within five minutes.
- The WebGPU process snapshot during sustained work peaked around 2.26 GB RSS for the renderer and
  1.40 GB RSS for the software GPU process. These are Linux process figures, not Android memory
  measurements.
- An isolated WASM run completed all 32 generated tokens on both medium- and low-tier emulated
  Android profiles. Results are below.
- Physical Android memory pressure, GPU behavior, thermal throttling and tab suspension remain
  untested. Playwright emulation is useful for capability/UI routing only.

## Partial measurements

| Profile / backend             | Cached load |    TTFT | 32-token generation | Throughput |
| ----------------------------- | ----------: | ------: | ------------------: | ---------: |
| Pixel 5 emulation / WebGPU    |     11.65 s |     n/a |              >60 s¹ |        n/a |
| Pixel 5 emulation / WASM      |      8.94 s | 20.34 s |             49.91 s | 0.64 tok/s |
| 2 GB Android emulation / WASM |     11.29 s |  7.97 s |             35.37 s | 0.90 tok/s |

¹ The SwiftShader run did not finish before the bound, so it has no defensible token-rate result.

| Additional measurement                         |                              Result |
| ---------------------------------------------- | ----------------------------------: |
| Main q4 model asset                            |                   386,495,938 bytes |
| Cached model-load attempt before WASM-path fix | 1,901–2,078 ms before typed failure |
| Peak WebGPU process RSS                        |     ~2.26 GB renderer + 1.40 GB GPU |
| Cross-origin isolation                         |                             enabled |
| CSP violations in completed comparison runs    |                                   0 |

`performance.measureUserAgentSpecificMemory()` returned a baseline near 17.8 MB but timed out after
load in several runs. The JS heap delta was only a few MB because it excludes the model's
WASM/native/GPU allocations. Process RSS is therefore included as pressure evidence, not as a
portable Android working-set measurement.

## Required completion run

1. Sync `grogoni-web-staging` in Render and supply an isolated staging API URL.
2. Run the benchmark command from `docs/render-frontend-deployment.md`.
3. Run WebGPU and WASM as separate browser processes so a timed-out WebGPU queue cannot contaminate
   WASM wall time.
4. Repeat on at least:
   - Android 12+ Qualcomm/ARM device with Chrome 121+ and WebGPU;
   - 3–4 GB Android device using WASM fallback;
   - current higher-memory Android device.
