import { describe, expect, it } from "vitest";
import { voiceAudioDurationSeconds } from "./audio-duration.js";
import { parseTranscriptionRequest } from "./voice-speech.js";

// Streaming WebM has an unknown Segment length, no Duration element, and Opus SimpleBlocks.
function webm(timestamp: number): Buffer {
  const cluster = Buffer.from([
    0x1f,
    0x43,
    0xb6,
    0x75,
    0x8b,
    0xe7,
    0x83,
    (timestamp >>> 16) & 255,
    (timestamp >>> 8) & 255,
    timestamp & 255,
    0xa3,
    0x84,
    0x81,
    0,
    0,
    0x80
  ]);
  // Add a 20 ms Opus packet and adjust the enclosing element sizes.
  cluster[4] = 0x8c;
  cluster[11] = 0x85;
  return Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0xff]), cluster, Buffer.from([0x08])]);
}

function mp3(frames: number): Buffer {
  // MPEG 1 Layer III, 128 kbps, 48 kHz, 384 bytes and 24 ms per frame.
  const frame = Buffer.alloc(384);
  frame.set([0xff, 0xfb, 0x94, 0x00]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

describe("voice audio duration", () => {
  it("measures streaming WebM from blocks even without a duration header", () => {
    expect(voiceAudioDurationSeconds(webm(119_980), "webm")).toBe(120);
    expect(voiceAudioDurationSeconds(webm(120_000), "webm")).toBe(120.02);
  });

  it("counts MP3 frames rather than estimating from file size", () => {
    expect(voiceAudioDurationSeconds(mp3(5000), "mp3")).toBeCloseTo(120);
    expect(voiceAudioDurationSeconds(mp3(5001), "mp3")).toBeGreaterThan(120);
  });

  it.each([
    [webm(120_000), "audio/webm"],
    [mp3(5001), "audio/mpeg"]
  ] as const)("rejects over-limit audio at the transcription boundary", (bytes, contentType) => {
    expect(() =>
      parseTranscriptionRequest({ audioBase64: bytes.toString("base64"), contentType })
    ).toThrow(/over 2 minutes/);
  });

  it("does not report a duration for malformed or truncated streams", () => {
    expect(voiceAudioDurationSeconds(Buffer.from("voice"), "webm")).toBeNull();
    expect(voiceAudioDurationSeconds(mp3(1).subarray(0, 200), "mp3")).toBeNull();
  });
});

function box(type: string, ...data: Buffer[]): Buffer {
  const contents = Buffer.concat(data);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(contents.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, contents]);
}

function m4a(samples: number): Buffer {
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(1000, 12);
  const hdlr = Buffer.alloc(12);
  hdlr.write("soun", 8);
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(samples, 8);
  stts.writeUInt32BE(20, 12);
  const stsz = Buffer.alloc(12);
  stsz.writeUInt32BE(1, 4);
  stsz.writeUInt32BE(samples, 8);
  return box(
    "moov",
    box(
      "trak",
      box(
        "mdia",
        box("mdhd", mdhd),
        box("hdlr", hdlr),
        box("minf", box("stbl", box("stts", stts), box("stsz", stsz)))
      )
    )
  );
}

function wav(seconds: number): Buffer {
  const samples = Buffer.alloc(seconds * 8000);
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(samples.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

function ogg(packets: number): Buffer {
  const page = (parts: Buffer[]) => {
    const header = Buffer.alloc(27 + parts.length);
    header.write("OggS");
    header[26] = parts.length;
    parts.forEach((part, i) => {
      header[27 + i] = part.length;
    });
    return Buffer.concat([header, ...parts]);
  };
  const header = page([Buffer.from("OpusHead"), Buffer.from("OpusTags")]);
  return Buffer.concat([
    header,
    ...Array.from({ length: packets }, () => page([Buffer.from([0x08])]))
  ]);
}

describe("bounded durations for other voice note formats", () => {
  it("validates WAV contents and rejects a truncated recording", () => {
    expect(voiceAudioDurationSeconds(wav(121), "wav")).toBe(121);
    expect(voiceAudioDurationSeconds(wav(2).subarray(0, 44), "wav")).toBeNull();
  });
  it("adds Ogg Opus packet durations even with zero granules", () => {
    expect(voiceAudioDurationSeconds(ogg(6001), "ogg")).toBe(120.02);
  });
  it("uses M4A audio sample timing and rejects missing tables", () => {
    expect(voiceAudioDurationSeconds(m4a(6001), "m4a")).toBe(120.02);
    expect(voiceAudioDurationSeconds(box("moov"), "m4a")).toBeNull();
  });
});
