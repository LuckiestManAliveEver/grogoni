// Paid eval: agents can speak and hear (voicecom P1.7).
// Run: pnpm eval:voice [--report <path>] [--no-browser]
// For each phrase, the production speaker (createVoiceServices, OpenRouter /audio/speech) says it,
// then the production transcriber (OpenRouter /audio/transcriptions) hears it back twice: as the
// MP3 the speaker returned, and as a WebM/Opus file re-recorded by Chromium's MediaRecorder,
// which is exactly what the web composer uploads. Scores word error rate per phrase.
// Pass: mean WER <= 0.15 per format, no phrase over 0.40, at most one failed call. Exit 0 = pass, 1 = fail, 2 = not run.
import { createRequire } from "node:module";
import type { chromium as Chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createVoiceServices,
  type VoiceAudioFormat
} from "../services/api/src/cp2/voice/voice-speech.ts";
import { wordErrorRate } from "../services/api/src/cp2/voice/word-error-rate.ts";

const meanThreshold = 0.15;
const phraseThreshold = 0.4;
const reportFlag = process.argv.indexOf("--report");
const reportPath =
  reportFlag === -1 ? "/tmp/voicecom/eval/report.json" : process.argv[reportFlag + 1]!;
const useBrowser = !process.argv.includes("--no-browser");
const write = (report: unknown) => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
};

const services = createVoiceServices(process.env);
if (!services.speaker || !services.transcriber) {
  write({ status: "not_run", reason: "OPENROUTER_API_KEY is not set or a voice model is off." });
  process.exit(2);
}
const { speaker, transcriber } = services;

const phrases: { text: string; language?: string }[] = [
  { text: "Your order of two crates of soda is ready for pickup." },
  { text: "I sold three loaves of bread and one packet of milk this morning." },
  { text: "Add twenty kilograms of maize flour to the next supplier order." },
  { text: "The invoice total is one thousand two hundred and fifty shillings." },
  { text: "How many bags of sugar are left in stock?" },
  { text: "Habari ya asubuhi, karibu dukani.", language: "sw" }
];

/** Re-records an MP3 as WebM/Opus through Chromium's MediaRecorder, in real time. */
async function browserRecorder() {
  // The repo's Playwright is @playwright/test (the receipt eval loads it the same way).
  const { chromium } = createRequire(import.meta.url)("@playwright/test") as {
    chromium: typeof Chromium;
  };
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  await page.setContent("<html><body>voice eval</body></html>");
  return {
    async toWebm(mp3: Buffer): Promise<{ bytes: Buffer; mimeType: string }> {
      const result = await page.evaluate(async (base64: string) => {
        const binary = atob(base64);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
        const context = new AudioContext();
        const buffer = await context.decodeAudioData(data.buffer);
        const destination = context.createMediaStreamDestination();
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        const mimeType = "audio/webm;codecs=opus";
        const recorder = new MediaRecorder(destination.stream, { mimeType });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
        recorder.start(250);
        source.start();
        await new Promise((resolve) => (source.onended = resolve));
        await new Promise((resolve) => setTimeout(resolve, 300));
        recorder.stop();
        await stopped;
        await context.close();
        const blob = new Blob(chunks, { type: "audio/webm" });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let out = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { base64: btoa(out), mimeType: "audio/webm" };
      }, mp3.toString("base64"));
      return { bytes: Buffer.from(result.base64, "base64"), mimeType: result.mimeType };
    },
    close: () => browser.close()
  };
}

interface Row {
  phrase: string;
  format: VoiceAudioFormat;
  audioBytes: number;
  transcript: string | null;
  wer: number;
  error?: string;
  ms: number;
}

const rows: Row[] = [];
const speechMs: number[] = [];
const recorder = useBrowser
  ? await browserRecorder().catch((error: unknown) => {
      console.warn(`Chromium is unavailable (${(error as Error).message}); scoring MP3 only.`);
      return null;
    })
  : null;
try {
  for (const phrase of phrases) {
    let spoken: Buffer;
    try {
      const speechStarted = Date.now();
      spoken = (await speaker({ text: phrase.text })).audio;
      speechMs.push(Date.now() - speechStarted);
    } catch (error) {
      rows.push({
        phrase: phrase.text,
        format: "mp3",
        audioBytes: 0,
        transcript: null,
        wer: 1,
        error: `speech failed: ${(error as Error).message}`,
        ms: 0
      });
      continue;
    }
    const inputs: { format: VoiceAudioFormat; bytes: Buffer }[] = [
      { format: "mp3", bytes: spoken }
    ];
    if (recorder) inputs.push({ format: "webm", bytes: (await recorder.toWebm(spoken)).bytes });
    for (const input of inputs) {
      const started = Date.now();
      try {
        const heard = await transcriber({
          bytes: input.bytes,
          format: input.format,
          ...(phrase.language ? { language: phrase.language } : {})
        });
        rows.push({
          phrase: phrase.text,
          format: input.format,
          audioBytes: input.bytes.length,
          transcript: heard.text,
          wer: wordErrorRate(phrase.text, heard.text),
          ms: Date.now() - started
        });
      } catch (error) {
        rows.push({
          phrase: phrase.text,
          format: input.format,
          audioBytes: input.bytes.length,
          transcript: null,
          wer: 1,
          error: `transcription failed: ${(error as Error).message}`,
          ms: Date.now() - started
        });
      }
    }
  }
} finally {
  await recorder?.close();
}

// A failed call (network, timeout, provider error) is not a hearing mistake: it is counted
// apart from word error rate, and more than maxErrors of them fails the run on its own.
const maxErrors = 1;
const scored = rows.filter((row) => row.error === undefined);
const errors = rows.filter((row) => row.error !== undefined);
const formats = [...new Set(rows.map((row) => row.format))];
const byFormat = Object.fromEntries(
  formats.map((format) => {
    const subset = scored.filter((row) => row.format === format);
    const mean = subset.length ? subset.reduce((sum, row) => sum + row.wer, 0) / subset.length : 1;
    return [
      format,
      {
        cases: subset.length,
        errors: errors.filter((row) => row.format === format).length,
        meanWer: Number(mean.toFixed(4))
      }
    ];
  })
);
const worst = scored.filter((row) => row.wer > phraseThreshold);
const passed =
  scored.length > 0 &&
  errors.length <= maxErrors &&
  Object.values(byFormat).every((summary) => summary.meanWer <= meanThreshold) &&
  worst.length === 0;
write({
  status: passed ? "pass" : "fail",
  ranAt: new Date().toISOString(),
  models: { speech: services.speechModel, transcription: services.transcriptionModel },
  thresholds: { meanWer: meanThreshold, phraseWer: phraseThreshold, maxErrors },
  byFormat,
  speechMs,
  rows
});
for (const row of rows)
  console.log(
    `${row.wer.toFixed(2)}  ${row.format.padEnd(4)}  ${row.phrase}  ->  ${row.transcript ?? row.error}`
  );
console.log(`${passed ? "PASS" : "FAIL"} ${JSON.stringify(byFormat)}`);
process.exit(passed ? 0 : 1);
