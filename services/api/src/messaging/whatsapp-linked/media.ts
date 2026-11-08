import { createHash, timingSafeEqual } from "node:crypto";
import type { ConversationAttachmentKind } from "@grogoni/shared-types";
import { sanitizeAttachmentFilename } from "../../cp2/workspace-file-delivery.js";

export const linkedMediaMaxBytes = 5 * 1024 * 1024;
export interface LinkedMedia {
  type: "image" | "document" | "audio";
  mimeType: string;
  filename: string;
  size: number;
  directPath: string;
  key: string;
  sha256: string;
}
export interface LinkedDownloadedMedia {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  kind: ConversationAttachmentKind;
  category: "image" | "document" | "audio";
}
export class LinkedMediaRejected extends Error {}

function imageDimensions(bytes: Buffer, mimeType: string): [number, number] {
  if (
    mimeType === "image/png" &&
    bytes.length >= 24 &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  )
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mimeType === "image/webp") {
    const chunk = bytes.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && bytes.length >= 30)
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (
      chunk === "VP8 " &&
      bytes.length >= 30 &&
      bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))
    )
      return [bytes.readUInt16LE(26) & 16383, bytes.readUInt16LE(28) & 16383];
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      return [1 + (bits & 16383), 1 + ((bits >>> 14) & 16383)];
    }
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      offset += 2;
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        length >= 8
      )
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += length;
    }
  }
  throw new LinkedMediaRejected("Image dimensions could not be verified.");
}

/** Untrusted files are stored as attachments; nothing here executes or extracts their content. */
export function validateLinkedMedia(media: LinkedMedia, bytes: Buffer): LinkedDownloadedMedia {
  if (bytes.length === 0 || bytes.length !== media.size || bytes.length > linkedMediaMaxBytes)
    throw new LinkedMediaRejected("Attachment size is invalid.");
  const expected = Buffer.from(media.sha256, "base64");
  const actual = createHash("sha256").update(bytes).digest();
  if (expected.length !== 32 || !timingSafeEqual(expected, actual))
    throw new LinkedMediaRejected("Attachment checksum is invalid.");
  const mimeType = media.mimeType.split(";")[0]!.trim().toLowerCase();
  const starts = (value: string) => bytes.subarray(0, value.length).toString("ascii") === value;
  let extension: string;
  let kind: ConversationAttachmentKind;
  if (mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    extension = "jpg";
    kind = "image";
  } else if (
    mimeType === "image/png" &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    extension = "png";
    kind = "image";
  } else if (
    mimeType === "image/webp" &&
    starts("RIFF") &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    extension = "webp";
    kind = "image";
  } else if (mimeType === "application/pdf" && starts("%PDF-")) {
    extension = "pdf";
    kind = "pdf";
  } else if (["text/plain", "text/csv"].includes(mimeType) && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new LinkedMediaRejected("Invalid text attachment.");
    }
    extension = mimeType === "text/csv" ? "csv" : "txt";
    kind = "text";
  } else if (["audio/ogg", "audio/opus"].includes(mimeType) && starts("OggS")) {
    extension = "ogg";
    kind = "file";
  } else if (
    mimeType === "audio/mpeg" &&
    (starts("ID3") || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224))
  ) {
    extension = "mp3";
    kind = "file";
  } else if (
    ["audio/mp4", "audio/x-m4a"].includes(mimeType) &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    extension = "m4a";
    kind = "file";
  } else if (
    ["audio/wav", "audio/x-wav"].includes(mimeType) &&
    starts("RIFF") &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    extension = "wav";
    kind = "file";
  } else throw new LinkedMediaRejected("Unsupported or mismatched attachment format.");
  const category =
    kind === "image" ? "image" : mimeType.startsWith("audio/") ? "audio" : "document";
  if (category === "image") {
    const [width, height] = imageDimensions(bytes, mimeType);
    if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 4_000_000)
      throw new LinkedMediaRejected("Image exceeds the four-megapixel processing limit.");
  }
  if (category !== media.type)
    throw new LinkedMediaRejected("Attachment type does not match its content.");
  const stem =
    sanitizeAttachmentFilename(media.filename)
      .replace(/\.[^.]*$/, "")
      .slice(0, 100) || "attachment";
  return { bytes, filename: `${stem}.${extension}`, mimeType, kind, category };
}
