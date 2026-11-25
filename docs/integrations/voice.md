# Voice: talking with agents

People can talk to an agent and listen to its replies. Speech-to-text (voice typing) and
text-to-speech (Listen) both run on the server through OpenRouter's audio endpoints, using
the same `OPENROUTER_API_KEY` as chat. The browser's own speech is the fallback.

| Direction    | Endpoint                    | OpenRouter                     | Default model                               |
| ------------ | --------------------------- | ------------------------------ | ------------------------------------------- |
| Voice typing | `POST /v1/voice/transcribe` | `/api/v1/audio/transcriptions` | `openai/gpt-4o-transcribe`                  |
| Listen       | `POST /v1/voice/speak`      | `/api/v1/audio/speech` (MP3)   | `elevenlabs/eleven-v4-turbo`, voice `sarah` |

Code: `services/api/src/cp2/voice/` (server), `apps/web/src/messaging/voice-speech.ts`,
`apps/web/src/hooks/useVoiceInput.ts`, `apps/web/src/hooks/useReadAloud.ts` (web).

## What the person sees

- **Voice typing.** Tap the microphone in the composer and speak, then tap again (it stops by
  itself at 60 s). The text is added to the draft. It is never sent without the person: they
  review it and press Send. Status line: "Listening…", then "Turning your words into text…".
  If the transcription fails (provider down, offline), the recording is kept and a **Try again**
  button sends the same audio again; nothing has to be said twice. Taps while the microphone
  is opening or while the text is coming back are ignored, and leaving the chat releases the
  microphone and cancels any upload.
- **Listen.** Agent replies have a Listen button. Long replies are split at sentence ends
  (900 characters per request). The next part is fetched while the current one plays, so a
  long reply does not pause between parts. Stop ends playback. Only one reply plays at a time.
  The tap itself starts one audio element on 50 ms of silence, then that element plays every
  part: iOS Safari only lets audio play after a network call if the element first played inside
  the tap. If the browser still refuses to play, the rest is read with `speechSynthesis`.
  Markdown, code, tables, HTML tags, link targets, URLs and entities are not read out;
  `stock_level`, prices (`KES 1,250.50`) and domains stay whole. Listen appears only once a reply
  has finished streaming. Browser speech, when used, speaks in 200-character parts (Chrome stops
  reporting the end of longer utterances) with a watchdog, so a part that never reports back
  ends playback as failed instead of leaving Stop showing forever; it is primed inside the tap
  for iOS.
- **Fallback.** If the server answers `voice_unavailable` (no key, or the model is set to `off`),
  the page remembers that until reload. Voice typing then uses the browser's Web Speech
  recognition on the next tap, and Listen uses `speechSynthesis` from the part that failed.
  Storefront guests use server speech when a guest session is available, with browser speech as
  the fallback.

## Voice notes to agents

A voice note sent in an agent conversation (in the app, not WhatsApp) is transcribed on the server
before the agent's turn (`services/api/src/cp2/voice/voice-note-evidence.ts`, called from
`createAgentConversationMessage` in `domains/messaging/store.ts`).

- **Evidence, never commands.** The agent receives the transcript quoted and labeled as the
  sender's words (`voiceNoteEvidenceLabel`), with the typed text that came with the note. A turn
  carrying a voice note never runs a tool: whatever the model or a deterministic parser proposes is
  narrowed to a clarification (`agent-runtime/voice-evidence-turn.ts`). To act, the person types
  and sends the request. Skill commands and inventory tasks are skipped for such turns too.
- **Which notes.** Embedded audio (data URLs) and managed attachments whose stored bytes match
  their checksum. URLs are never fetched. A recording over 4 MiB or 2 minutes, one whose length
  cannot be measured, or one whose transcription fails stays a plain voice note: the agent is
  told the transcription is unavailable and the message is delivered as usual. Duration is read
  from the container for WebM (block timecodes, so MediaRecorder streams without a duration
  header are covered), Ogg Opus, MP3 (frame by frame), WAV and M4A (`audio-duration.ts`).
- **Who.** Never in person-to-person chats: those are end-to-end encrypted and the server cannot
  read them. Access is checked again after the provider call; a message deleted or a
  conversation whose access changed meanwhile is not processed.
- **Edge.** The provider call is deferred out of the database transaction and replayed across
  attempts like model calls (`edge-model-deferral.ts`), so it never holds a Neon connection.
- **Transcript on the note.** A successful transcript is saved on the attachment
  (`transcript: { text, model, transcribedAt }`) and synced to every participant; the chat shows
  a collapsible **Transcript** under the voice note. Only the server writes it: the message API
  drops a client-sent `transcript`, and the web client ignores one inside decrypted content.
  A regenerated reply reuses the saved transcript instead of calling the provider again.

## Guests on the storefront

Signed-out storefront guests get the same two calls at
`POST /public/storefronts/:agentId/voice/transcribe` and `.../speak`, with their storefront
`capabilityToken` in the body (`registerGuestVoiceRoutes`). A guest needs a valid, unexpired,
unrevoked capability; each capability gets 5 transcriptions and 10 speech calls a minute. On Edge
the token is checked with one indexed read of `customer_runtime_capabilities` (no snapshot, lock
or held connection). The storefront chat uses server voice once its guest session exists, and its
agent replies have Listen. The transcript or audio goes back only to the caller and touches no
shop data, so the storefront id in the path is not a trust boundary.

## Android

The Android app declares `RECORD_AUDIO`. Android asks for it at the first tap on a microphone,
never in the bulk permission request, and only the app's own pages get audio
(`PermissionChecklistPolicy.audioCaptureDecision`, tested in `PermissionChecklistPolicyTest`).
Play declarations: `docs/android/play-console-submission.md`.

## API

`POST /v1/voice/transcribe` with `{ audioBase64, contentType, language? }` returns
`{ text, model }`.

- `contentType` must be one of `audio/webm`, `audio/ogg`, `audio/opus`, `audio/mp4`,
  `audio/x-m4a`, `audio/aac`, `audio/mpeg`, `audio/wav`, `audio/x-wav` or `audio/wave`.
  Codec parameters are allowed.
- The limits are 4 MiB of audio and 2 minutes where the recording's duration can be measured.
  Voice-note processing requires a measurable duration; see the voice-note section above.
- `language` is an optional ISO-639-1 code (`en`, `sw`). Without it, the model detects the
  language.

`POST /v1/voice/speak` with `{ text }` (1 to 1000 characters) returns
`{ audioBase64, contentType, model, voice }`.

Both routes need a signed-in session and answer with `cache-control: no-store`. Each account
may make 20 transcriptions and 40 speech calls per minute (`createVoiceRateLimiter` in
`voice-routes.ts`, enforced in the handlers on Node and Edge alike). The count lives in the
process: each Edge isolate keeps its own, so a busy account spread over isolates can exceed it.
A durable daily quota per account is still open (voicecom P3.4). The routes add no per-IP limit
of their own, so a shop's shared Wi-Fi is not limited as one person; the API-wide per-IP limits
(Node's global `@fastify/rate-limit`, Edge's `rate-limit.ts`) still apply. Errors:

| Status | `code`                                                                                                                                         | Meaning                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 401    | `auth_required`                                                                                                                                | Not signed in. No provider call is made.                                                                           |
| 429    | `voice_rate_limited`                                                                                                                           | Over the account's per-minute limit. No provider call is made.                                                     |
| 400    | `voice_audio_invalid`, `voice_audio_unsupported`, `voice_audio_too_large`, `voice_audio_too_long`, `voice_text_invalid`, `voice_text_too_long` | Bad input. No provider call is made.                                                                               |
| 503    | `voice_unavailable`                                                                                                                            | This host has no speech service. The web client falls back to browser speech.                                      |
| 502    | `voice_provider_failed`                                                                                                                        | OpenRouter failed. The message is redacted, and `retryable` is set for 429, 5xx, connection failures and timeouts. |

## Configuration

Set these as Supabase Edge secrets or in the Node API environment:

| Variable                    | Default                      | Notes                                                                                                      |
| --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`        | none                         | Without it, both routes answer `voice_unavailable`.                                                        |
| `VOICE_TRANSCRIPTION_MODEL` | `openai/gpt-4o-transcribe`   | An OpenRouter model id, or `off`.                                                                          |
| `VOICE_SPEECH_MODEL`        | `elevenlabs/eleven-v4-turbo` | An OpenRouter model id that returns MP3, or `off`. Gemini TTS returns PCM only and does not fit.           |
| `VOICE_SPEECH_VOICE`        | `sarah`                      | Must be a voice the speech model lists: `GET https://openrouter.ai/api/v1/audio/speech/models/<model id>`. |
| `VOICE_TIMEOUT_MS`          | `30000`                      | 1000 to 35000 (the web client waits 45 s; a connect retry can add 10 s).                                   |

If any of these is invalid, the Node API stops at startup. The Edge API logs
`voice_configuration_invalid` and answers `voice_unavailable`; chat keeps working.

## Reliability, privacy and trust

- On Edge, the voice routes run in the same database-free Fastify instance as the image reader.
  The session lookup commits before the model call, so speech never holds a Neon connection
  or snapshot lock. This is covered by a test in `tests/supabase-edge-domain-routes.test.ts`.
- Host fallback is on (`allow_fallbacks: true, sort: latency`), as Julien chose for chat on
  2026-11-17. The request names one model, so a fallback can only change which host serves it.
- A call is retried once only when it provably never reached OpenRouter: the fetch failed with
  `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH` or
  `UND_ERR_CONNECT_TIMEOUT` (`HostedConnectionError.requestNotSent` in
  `inference/hosted-http.ts`). Nothing was billed for that attempt. A reset or socket error
  (which can come after the request was sent), an HTTP error, a body that breaks off, a timeout
  or a cancellation is never retried. The causes come from Node's fetch (undici). Deno's fetch on Edge may not
  report them; then a failed call on Edge is simply not retried, which is the safe side.
- When the client disconnects before the answer (the person tapped Stop, closed the tab, or the
  45 s client timeout passed), the Node API aborts the provider call. On Edge the request is
  replayed into an in-process Fastify app that cannot see the browser connection, so the call
  runs to its own 30 s timeout; it still answers nobody and is traced as usual.
- Speech endpoint audio and text are not stored or logged by the endpoint. Voice-note transcripts
  can be stored with the message as described above. Each call writes one line, `voice.transcribed` or
  `voice.spoken` (`voice.transcribe_failed` / `voice.speak_failed` with the error code), with the
  model, sizes and milliseconds, and no content or account id. On Node it goes to the request
  logger; on Edge, where Fastify logging is off, it is a JSON line on stdout (warn for
  failures), which Supabase function logs keep.
- A transcript goes into the speaker's own draft. It is the person's words for them to review,
  not an instruction to the agent until they send it.

## Eval

`pnpm eval:voice` (billed, about $0.01 a run) works like this:

1. The production speaker says six shop phrases: five in English, one in Swahili.
2. The production transcriber hears each one twice: as the MP3 that was returned, and as a
   WebM/Opus file that Chromium's `MediaRecorder` re-records. That WebM file is exactly what the
   composer uploads.
3. Each result is scored by word error rate (`services/api/src/cp2/voice/word-error-rate.ts`,
   with number words matched to numerals).

To pass, the mean WER must be at most 0.15 per format, no phrase may be over 0.40, and at most
one call may fail. Failed calls are counted separately from WER. The report goes to
`/tmp/voicecom/eval/report.json`.

Model choice on 2026-11-24, with ElevenLabs speech feeding the transcription rows:

| Model                            | Role          | Mean WER mp3 / webm | Notes                                                                                                                                  |
| -------------------------------- | ------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `elevenlabs/eleven-v4-turbo`     | speech        | 0 / 0               | Every word, Swahili included. **Default.**                                                                                             |
| `mistralai/voxtral-mini-tts-3-0` | speech        | 0.026 / 0.026       | Dropped "this morning".                                                                                                                |
| `openai/gpt-4o-transcribe`       | transcription | 0 / 0               | About 4.0 s per call. **Default**, from a different vendor than the speech model, so the eval never grades a vendor with its own ears. |
| `elevenlabs/scribe-v2`           | transcription | 0 / 0               | About 3.4 s per call. Same vendor as the speech model.                                                                                 |
| `openai/gpt-4o-mini-transcribe`  | transcription | 0.2 / 0.12          | Misheard the Swahili phrase.                                                                                                           |
| `google/gemini-3.5-transcribe`   | transcription | 0 / 0               | About 8.6 s per call.                                                                                                                  |
| `openai/whisper-large-v3-turbo`  | transcription | 0.033 / 0.2         | "asubuhi" heard as "subuhi"; one 30 s timeout.                                                                                         |

Gate tests (no network) are in `services/api/src/cp2/voice/voice-routes.test.ts`,
`tests/voice-speech.test.ts`, `tests/voice-input-hook.test.tsx`, `tests/read-aloud.test.tsx`, the voice case in
`tests/supabase-edge-domain-routes.test.ts` and `tests/api-response-budget.test.ts`.
