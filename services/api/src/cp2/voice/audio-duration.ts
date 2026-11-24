import type { VoiceAudioFormat } from "./voice-speech.js";

// MPEG Layer III frame headers describe the exact number of samples even for VBR files.
function mp3Duration(bytes: Buffer): number | null {
  let offset = 0;
  if (bytes.subarray(0, 3).toString() === "ID3") {
    if (bytes.length < 10 || [...bytes.subarray(6, 10)].some((byte) => byte >= 128)) return null;
    offset = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
    if (bytes[5]! & 0x10) offset += 10;
  }
  let seconds = 0;
  let compensation = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes.length - offset === 128 && bytes.toString("ascii", offset, offset + 3) === "TAG") {
      offset += 128;
      break;
    }
    const header = bytes.readUInt32BE(offset);
    const version = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const rateIndex = (header >>> 10) & 3;
    if (
      header >>> 21 !== 0x7ff ||
      version === 1 ||
      layer !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      rateIndex === 3
    )
      return null;
    const bitrate =
      (version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex]! * 1000;
    const rate = [44100, 48000, 32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const size = Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) + ((header >>> 9) & 1);
    if (size < 4 || offset + size > bytes.length) return null;
    const increment = (version === 3 ? 1152 : 576) / rate - compensation;
    const sum = seconds + increment;
    compensation = sum - seconds - increment;
    seconds = sum;
    frames++;
    offset += size;
  }
  return frames && offset === bytes.length ? seconds : null;
}

// Read an EBML variable integer. Unknown lengths are used by streaming MediaRecorder segments.
function vint(
  bytes: Buffer,
  offset: number,
  keepMarker = false
): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[offset];
  if (!first) return null;
  let mask = 0x80;
  let length = 1;
  while (!(first & mask) && length <= 8) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let unknown = !keepMarker && (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i]!;
    unknown &&= bytes[offset + i] === 255;
  }
  return Number.isSafeInteger(value) ? { value, length, unknown } : null;
}

// Opus packet duration from the TOC (RFC 6716 section 3.1), in milliseconds.
function opusDuration(packet: Buffer): number | null {
  if (!packet.length) return null;
  const toc = packet[0]!;
  const config = toc >>> 3;
  const frameMs =
    config < 12
      ? [10, 20, 40, 60][config % 4]!
      : config < 16
        ? [10, 20][config % 2]!
        : [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 63 : 2;
  const duration = frameMs * count;
  return count && duration <= 120 ? duration : null;
}

function webmDuration(bytes: Buffer): number | null {
  let scale = 1_000_000; // Matroska default: 1 ms per tick.
  let maxEndMs = 0;
  let packetTotalMs = 0;
  let blocks = 0;
  let valid = true;
  const containers = new Set([0x18538067, 0x1549a966, 0x1f43b675]);
  function walk(start: number, end: number, clusterTime: number | null): void {
    let position = start;
    let currentCluster = clusterTime;
    while (position < end && valid) {
      const id = vint(bytes, position, true);
      if (!id) {
        valid = false;
        break;
      }
      const size = vint(bytes, position + id.length);
      if (!size) {
        valid = false;
        break;
      }
      const data = position + id.length + size.length;
      const next = size.unknown ? end : data + size.value;
      if (next > end || next < data) {
        valid = false;
        break;
      }
      if (containers.has(id.value)) walk(data, next, id.value === 0x1f43b675 ? 0 : currentCluster);
      else if (id.value === 0x2ad7b1 || id.value === 0xe7) {
        if (size.value < 1 || size.value > 6) {
          valid = false;
          break;
        }
        let value = 0;
        for (let i = data; i < next; i++) value = value * 256 + bytes[i]!;
        if (id.value === 0x2ad7b1) scale = value;
        else currentCluster = value;
      } else if (id.value === 0xa0 && currentCluster !== null) {
        // BlockGroups can contain explicit durations and lacing; reject until fully supported.
        valid = false;
        break;
      } else if (id.value === 0xa3 && currentCluster !== null) {
        const track = vint(bytes, data);
        const block = data + (track?.length ?? 0);
        if (!track || block + 3 >= next || bytes[block + 2]! & 6) {
          valid = false;
          break;
        }
        const packetMs = opusDuration(bytes.subarray(block + 3, next));
        if (packetMs === null) {
          valid = false;
          break;
        }
        const timestamp = currentCluster + bytes.readInt16BE(block);
        if (timestamp < 0) {
          valid = false;
          break;
        }
        packetTotalMs += packetMs;
        maxEndMs = Math.max(maxEndMs, (timestamp * scale) / 1_000_000 + packetMs);
        blocks++;
      }
      position = next;
    }
  }
  walk(0, bytes.length, null);
  return valid && blocks && scale > 0 ? Math.max(maxEndMs, packetTotalMs) / 1000 : null;
}

// PCM WAV duration is bounded by actual data bytes, not a declared duration alone.
function wavDuration(bytes: Buffer): number | null {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return null;
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) return null;
    if (id === "fmt ") {
      if (size < 16 || bytes.readUInt16LE(offset + 8) !== 1) return null;
      const channels = bytes.readUInt16LE(offset + 10);
      const rate = bytes.readUInt32LE(offset + 12);
      const bits = bytes.readUInt16LE(offset + 22);
      const expected = (channels * rate * bits) / 8;
      byteRate = bytes.readUInt32LE(offset + 16);
      if (!channels || !rate || !bits || byteRate !== expected) return null;
    }
    if (id === "data") dataBytes += size;
    offset = end;
  }
  return offset === bytes.length && byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : null;
}

// Ogg Opus packet durations prevent understated granule positions from hiding long audio.
function oggDuration(bytes: Buffer): number | null {
  let offset = 0;
  let packet: number[] = [];
  let header = false;
  let totalMs = 0;
  let audioPackets = 0;
  while (offset < bytes.length) {
    if (
      offset + 27 > bytes.length ||
      bytes.toString("ascii", offset, offset + 4) !== "OggS" ||
      bytes[offset + 4] !== 0
    )
      return null;
    const count = bytes[offset + 26]!;
    if (offset + 27 + count > bytes.length) return null;
    let data = offset + 27 + count;
    for (let i = 0; i < count; i++) {
      const size = bytes[offset + 27 + i]!;
      if (data + size > bytes.length) return null;
      // Audio packets have a maximum duration of 120 ms; retaining a capped packet avoids
      // allocating an unbounded array for invalid input while preserving TOC bytes.
      if (packet.length < 8)
        packet.push(...bytes.subarray(data, data + Math.min(size, 8 - packet.length)));
      data += size;
      if (size < 255) {
        const content = Buffer.from(packet);
        if (content.toString("ascii", 0, 8) === "OpusHead") header = true;
        else if (content.toString("ascii", 0, 8) !== "OpusTags") {
          if (!header) return null;
          const duration = opusDuration(content);
          if (duration === null) return null;
          totalMs += duration;
          audioPackets++;
        }
        packet = [];
      }
    }
    offset = data;
  }
  return header && audioPackets && packet.length === 0 ? totalMs / 1000 : null;
}

// Read the audio track's sample timing table rather than trusting the movie duration.
function mp4Duration(bytes: Buffer): number | null {
  type Box = { type: string; start: number; end: number };
  function boxes(start: number, end: number): Box[] | null {
    const result: Box[] = [];
    while (start < end) {
      if (start + 8 > end) return null;
      let size = bytes.readUInt32BE(start);
      let header = 8;
      if (size === 1) {
        if (start + 16 > end) return null;
        const extended = bytes.readBigUInt64BE(start + 8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || start + size > end) return null;
      result.push({
        type: bytes.toString("ascii", start + 4, start + 8),
        start: start + header,
        end: start + size
      });
      start += size;
    }
    return result;
  }
  function children(box: Box, type: string): Box[] | null {
    const list = boxes(box.start, box.end);
    return list && list.filter((item) => item.type === type);
  }
  const top = boxes(0, bytes.length);
  const movies = top?.filter((box) => box.type === "moov");
  if (!movies || movies.length !== 1 || top?.some((box) => box.type === "moof")) return null;
  const tracks = children(movies[0]!, "trak");
  if (!tracks) return null;
  let total = 0;
  let audioTracks = 0;
  for (const track of tracks) {
    const media = children(track, "mdia");
    if (!media || media.length !== 1) return null;
    const headers = children(media[0]!, "hdlr");
    if (!headers || headers.length !== 1 || headers[0]!.start + 12 > headers[0]!.end) return null;
    if (bytes.toString("ascii", headers[0]!.start + 8, headers[0]!.start + 12) !== "soun") continue;
    const mdhd = children(media[0]!, "mdhd");
    const minf = children(media[0]!, "minf");
    if (!mdhd || mdhd.length !== 1 || !minf || minf.length !== 1) return null;
    const version = bytes[mdhd[0]!.start];
    const scaleOffset = mdhd[0]!.start + (version === 1 ? 20 : 12);
    if ((version !== 0 && version !== 1) || scaleOffset + 4 > mdhd[0]!.end) return null;
    const scale = bytes.readUInt32BE(scaleOffset);
    const stbl = children(minf[0]!, "stbl");
    if (!scale || !stbl || stbl.length !== 1) return null;
    const timing = children(stbl[0]!, "stts");
    if (!timing || timing.length !== 1 || timing[0]!.start + 8 > timing[0]!.end) return null;
    const count = bytes.readUInt32BE(timing[0]!.start + 4);
    if (!count || timing[0]!.start + 8 + count * 8 !== timing[0]!.end) return null;
    const sizes = children(stbl[0]!, "stsz");
    if (!sizes || sizes.length !== 1 || sizes[0]!.start + 12 > sizes[0]!.end) return null;
    const sampleSize = bytes.readUInt32BE(sizes[0]!.start + 4);
    const declaredSamples = bytes.readUInt32BE(sizes[0]!.start + 8);
    if (!sampleSize && sizes[0]!.start + 12 + declaredSamples * 4 !== sizes[0]!.end) return null;
    let sampleTotal = 0;
    let ticks = 0n;
    for (let i = 0; i < count; i++) {
      const at = timing[0]!.start + 8 + i * 8;
      const samples = bytes.readUInt32BE(at);
      const delta = bytes.readUInt32BE(at + 4);
      if (!samples || !delta) return null;
      sampleTotal += samples;
      ticks += BigInt(samples) * BigInt(delta);
    }
    if (sampleTotal !== declaredSamples) return null;
    total += Number(ticks) / scale;
    audioTracks++;
  }
  return audioTracks ? total : null;
}

/** Returns null if duration cannot be established; callers requiring a bound must fail closed. */
export function voiceAudioDurationSeconds(bytes: Buffer, format: VoiceAudioFormat): number | null {
  if (format === "webm") return webmDuration(bytes);
  if (format === "mp3") return mp3Duration(bytes);
  if (format === "ogg") return oggDuration(bytes);
  if (format === "wav") return wavDuration(bytes);
  return mp4Duration(bytes);
}
