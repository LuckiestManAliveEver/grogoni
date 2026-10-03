import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type {
  ClientWorkspaceFileTransfer,
  ConversationAttachment,
  ConversationAttachmentKind
} from "@grogoni/shared-types";
import { Cp2Error } from "./cp2-error.js";

export interface ConversationAttachmentRecord {
  id: string;
  accountId: string;
  userId: string;
  businessId: string;
  conversationId: string;
  messageId: string | null;
  toolCallId: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: ConversationAttachmentKind;
  previewable: boolean;
  caption: string | null;
  checksum: string;
  storageKey: string;
  createdAt: string;
}

export interface ResolvedWorkspaceFile {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  kind: ConversationAttachmentKind;
  previewable: boolean;
  checksum: string;
}

export async function resolveWorkspaceFile(input: {
  workspaceRoot: string;
  requestedPath: string;
  maxFileBytes: number;
}): Promise<ResolvedWorkspaceFile> {
  const requestedPath = normalizeRequestedPath(input.requestedPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(input.workspaceRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw workspaceDeliveryError(
      409,
      "WORKSPACE_UNAVAILABLE",
      "The active workspace is unavailable."
    );
  }

  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(canonicalRoot, requestedPath);
  assertInsideWorkspace(canonicalRoot, candidate);

  let canonicalFile: string;
  try {
    canonicalFile = await realpath(candidate);
  } catch {
    throw workspaceDeliveryError(
      404,
      "FILE_NOT_FOUND",
      "The requested workspace file does not exist."
    );
  }
  assertInsideWorkspace(canonicalRoot, canonicalFile);

  let handle;
  try {
    handle = await open(canonicalFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw workspaceDeliveryError(
        400,
        "PATH_NOT_FILE",
        "The requested workspace path is not a file."
      );
    }
    if (metadata.size > input.maxFileBytes) {
      throw workspaceDeliveryError(
        413,
        "FILE_TOO_LARGE",
        "The requested workspace file is too large."
      );
    }
    const bytes = await handle.readFile();
    const filename = sanitizeAttachmentFilename(basename(canonicalFile));
    const mimeType = detectMimeType(filename, bytes);
    const kind = attachmentKind(filename, mimeType);
    return {
      bytes,
      filename,
      mimeType,
      size: bytes.byteLength,
      kind,
      previewable: isPreviewableMimeType(mimeType),
      checksum: createHash("sha256").update(bytes).digest("hex")
    };
  } catch (error) {
    if (error instanceof Cp2Error) throw error;
    throw workspaceDeliveryError(
      403,
      "FILE_UNREADABLE",
      "The requested workspace file cannot be read."
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function resolveTransferredWorkspaceFile(input: {
  requestedPath: string;
  transfer: ClientWorkspaceFileTransfer;
  maxFileBytes: number;
}): ResolvedWorkspaceFile {
  const requestedPath = normalizeWorkspaceRelativePath(input.requestedPath);
  const transferredPath = normalizeWorkspaceRelativePath(input.transfer.path);
  if (requestedPath !== transferredPath) {
    throw workspaceDeliveryError(
      400,
      "LOCAL_FILE_TRANSFER_MISMATCH",
      "The transferred file does not match the requested workspace file."
    );
  }
  const encoded = input.transfer.contentBase64.trim();
  if (!isCanonicalBase64(encoded)) {
    throw workspaceDeliveryError(
      400,
      "LOCAL_FILE_TRANSFER_INVALID",
      "The transferred workspace file is invalid."
    );
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > input.maxFileBytes) {
    throw workspaceDeliveryError(
      413,
      "FILE_TOO_LARGE",
      "The requested workspace file is too large."
    );
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== input.transfer.checksum.toLowerCase()) {
    throw workspaceDeliveryError(
      400,
      "LOCAL_FILE_TRANSFER_CHECKSUM_MISMATCH",
      "The transferred workspace file failed its integrity check."
    );
  }
  const filename = sanitizeAttachmentFilename(basename(requestedPath));
  const mimeType = detectMimeType(filename, bytes);
  const kind = attachmentKind(filename, mimeType);
  return {
    bytes,
    filename,
    mimeType,
    size: bytes.byteLength,
    kind,
    previewable: isPreviewableMimeType(mimeType),
    checksum
  };
}

export function managedAttachmentFromRecord(
  record: ConversationAttachmentRecord
): ConversationAttachment & {
  source: "managed";
  kind: ConversationAttachmentKind;
  previewable: boolean;
} {
  return {
    id: record.id,
    name: record.filename,
    mimeType: record.mimeType,
    size: record.size,
    category: attachmentCategory(record.kind),
    source: "managed",
    kind: record.kind,
    previewable: record.previewable,
    ...(record.caption === null ? {} : { caption: record.caption })
  };
}

export function sanitizeAttachmentFilename(value: string): string {
  const sanitized = [...value.normalize("NFC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 || character === "/" || character === "\\"
        ? "-"
        : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  return sanitized || "attachment";
}

export function contentDispositionFilename(value: string): string {
  return sanitizeAttachmentFilename(value).replace(/["\\]/gu, "-");
}

export function contentDispositionHeader(
  disposition: "attachment" | "inline",
  value: string
): string {
  const filename = contentDispositionFilename(value);
  const asciiFallback = filename.replace(/[^\x20-\x7e]/gu, "_");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function normalizeRequestedPath(value: string): string {
  let normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\u0000")) {
    throw workspaceDeliveryError(
      400,
      "FILE_NOT_FOUND",
      "The requested workspace file does not exist."
    );
  }
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(normalized) || normalized.includes("\\")) {
    throw workspaceDeliveryError(
      403,
      "PATH_OUTSIDE_WORKSPACE",
      "The requested file is outside the active workspace."
    );
  }
  for (let index = 0; index < 2 && /%[0-9a-f]{2}/iu.test(normalized); index += 1) {
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      throw workspaceDeliveryError(
        400,
        "FILE_NOT_FOUND",
        "The requested workspace file does not exist."
      );
    }
  }
  normalized = normalized.replace(/^\.\//u, "").replace(/^workspace\//u, "");
  return normalized;
}

export function normalizeWorkspaceRelativePath(value: string): string {
  const normalized = normalizeRequestedPath(value);
  if (isAbsolute(normalized)) {
    throw workspaceDeliveryError(
      403,
      "PATH_OUTSIDE_WORKSPACE",
      "The requested file is outside the active workspace."
    );
  }
  const workspaceRoot = resolve(sep, "workspace");
  const candidate = resolve(workspaceRoot, normalized);
  assertInsideWorkspace(workspaceRoot, candidate);
  const relativePath = relative(workspaceRoot, candidate);
  if (relativePath === "") {
    throw workspaceDeliveryError(
      400,
      "PATH_NOT_FILE",
      "The requested workspace path is not a file."
    );
  }
  return relativePath.split(sep).join("/");
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const relativePath = relative(workspaceRoot, candidate);
  if (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  ) {
    return;
  }
  throw workspaceDeliveryError(
    403,
    "PATH_OUTSIDE_WORKSPACE",
    "The requested file is outside the active workspace."
  );
}

function detectMimeType(filename: string, bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const header = bytes.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";

  const extension = extname(filename).toLowerCase();
  const known = mimeByExtension[extension];
  if (known !== undefined) return known;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return "application/zip";
  }
  return looksLikeText(bytes) ? "text/plain" : "application/octet-stream";
}

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.includes(0)) return false;
  return sample.toString("utf8").includes("�") === false;
}

function attachmentKind(filename: string, mimeType: string): ConversationAttachmentKind {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (isSafeTextMimeType(mimeType)) return "text";
  if (mimeType === "application/zip" || /\.(?:7z|gz|rar|tar|zip)$/iu.test(filename))
    return "archive";
  if (/\.(?:doc|docx|odp|ods|odt|ppt|pptx|rtf|xls|xlsx)$/iu.test(filename)) return "document";
  return "file";
}

function attachmentCategory(kind: ConversationAttachmentKind): ConversationAttachment["category"] {
  if (kind === "image") return "image";
  if (["pdf", "text", "document", "archive"].includes(kind)) return "document";
  return "other";
}

function isPreviewableMimeType(mimeType: string): boolean {
  return (
    ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"].includes(mimeType) ||
    isSafeTextMimeType(mimeType)
  );
}

function isSafeTextMimeType(mimeType: string): boolean {
  return (
    (mimeType.startsWith("text/") && mimeType !== "text/html" && mimeType !== "image/svg+xml") ||
    ["application/json", "application/sql", "application/xml"].includes(mimeType)
  );
}

function workspaceDeliveryError(statusCode: number, code: string, message: string): Cp2Error {
  return new Cp2Error(statusCode, code, message);
}

const mimeByExtension: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".css": "text/css",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".py": "text/x-python",
  ".sql": "application/sql",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip"
};
